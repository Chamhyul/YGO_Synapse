'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { randomBytes, createHash } = require('node:crypto');
const { FieldValue } = require('firebase-admin/firestore');
const { open } = require('../../integration/user-migration/connection.cjs');
const { createUserInventoryWriterBinding } = require('../services/userInventoryWriterRepository');
const { createMembershipCsvService } = require('../services/membershipCsvService');
const { createMembershipCsvLookup } = require('../services/user-storage/membershipCsvLookup');
const C = require('../services/membershipCsvWriterContract');
const id = () => randomBytes(16).toString('hex');
const member = n => ({ channelId: 'UC' + String(n).padStart(22, '0'), memberName: '합성 이름', levelName: `합성${n}` });
async function setup() {
  const c = open(id()), runId = id();
  const b = createUserInventoryWriterBinding({ db: c.db, database: c.targetDatabase, bucket: c.bucket, FieldValue, runId,
    migration: { prepareInventoryV2: async () => {}, inventoryMigrationStatus: () => ({ status: 'complete' }) }, config: c.config });
  await b.initialize(); let writer = await b.transition.route(); await b.transition.copy(writer); await b.transition.drain(writer); await b.transition.activate(writer);
  const service = createMembershipCsvService({ store: b.membershipCsv });
  const publish = async members => { const request = { members, ...await service.preview({ members }), operationId: id() }; await service.apply(request, 'synthetic'); return request.operationId; };
  return { ...b, c, service, publish, close: () => c.close() };
}
test('회원·비회원 최소 조회는 CSV 쓰기 잠금·journal 변경 없이 동작하고 API 원문은 보존한다', async () => {
  const f = await setup(); try {
    const version = await f.publish([member(1), member(3), member(5)]), writer = await f.transition.route(), external = id();
    await f.transition.beginExternal(writer, external, ['csv/control']);
    const before = await f.transition.inspect();
    for (const n of [0, 1, 2, 3, 4, 5, 6]) {
      const expected = [1, 3, 5].includes(n) ? { channelId: member(n).channelId, levelName: member(n).levelName } : null;
      assert.deepEqual(await f.membershipCsv.readMemberSummary(member(n).channelId), expected);
    }
    assert.deepEqual(await f.membershipCsv.readMember(member(1).channelId), member(1));
    assert.equal((await f.service.summary()).count, 3);
    assert.equal((await f.service.preview({ members: [member(1)] })).previousCount, 3);
    assert.deepEqual(await f.transition.inspect(), before);
    await f.transition.endExternal(external);
    const pointer = (await f.csvAdapters.rtdb.inspect('csv/control')).entry.value.active;
    const index = (await f.c.targetDatabase.ref(`membershipCsvLookup/${version}/${pointer.fingerprint}`).get()).val();
    assert(!JSON.stringify(index).includes('합성 이름'));
  } finally { await f.close(); }
});
test('단일 회원 삭제·등급 변조·부분 색인은 비회원이나 성공으로 처리하지 않는다', async () => {
  const f = await setup(); try {
    const version = await f.publish([member(1), member(3), member(5)]), pointer = (await f.csvAdapters.rtdb.inspect('csv/control')).entry.value.active;
    const base = f.c.targetDatabase.ref(`membershipCsvLookup/${version}/${pointer.fingerprint}`), original = (await base.get()).val();
    await base.child(`entries/${member(3).channelId}`).remove();
    await assert.rejects(f.membershipCsv.readMemberSummary(member(3).channelId), { code: 'CSV_WRITER_LOOKUP_INVALID' });
    await base.set(original); await base.child(`entries/${member(1).channelId}/levelName`).set('변조');
    await assert.rejects(f.membershipCsv.readMemberSummary(member(1).channelId), { code: 'CSV_WRITER_LOOKUP_INVALID' });
    await base.set(original); await base.child('entries').remove();
    await assert.rejects(f.membershipCsv.readMemberSummary(member(3).channelId), { code: 'CSV_WRITER_LOOKUP_INVALID' });
    // 검증된 원본 manifest에서 실제로 없는 채널은 색인 누락 때문에 회원으로 바뀌지 않는다.
    assert.equal(await f.membershipCsv.readMemberSummary(member(4).channelId), null);
    assert.equal((await f.transition.inspect()).unresolved, 0);
  } finally { await f.close(); }
});
test('구형 색인 없는 목록은 인증 읽기에서 새 쓰기 없이 원본으로 호환한다', async () => {
  const f = await setup(); try {
    const version = await f.publish([member(1)]), pointer = (await f.csvAdapters.rtdb.inspect('csv/control')).entry.value.active;
    await f.c.targetDatabase.ref(`membershipCsvLookup/${version}`).remove();
    const before = await f.transition.inspect();
    assert.deepEqual(await f.membershipCsv.readMemberSummary(member(1).channelId), { channelId: member(1).channelId, levelName: member(1).levelName });
    assert.equal((await f.c.targetDatabase.ref(`membershipCsvLookup/${version}`).get()).exists(), false);
    assert.deepEqual(await f.transition.inspect(), before);
  } finally { await f.close(); }
});
test('완료 저장 직전 목록이 교체되면 새 목록을 사용하고 저장 중에는 교체를 막는다', async () => {
  const f = await setup(); try {
    await f.publish([member(1)]);
    const uid = id(), now = Date.now(), nonceHash = createHash('sha256').update(id()).digest('hex');
    await f.membership.start(uid, 'youtube', { nonceHash, startedAt: now, expiresAt: now + 300000, consumed: false, localOnly: true });
    const add = f.transition.addExternalResources; let replaced = false;
    f.transition.addExternalResources = async (...args) => {
      if (args[1].includes('csv/control') && !replaced) { replaced = true; await f.publish([member(3)]); }
      return add(...args);
    };
    await f.membership.withVerification(uid, 'youtube', async () => {
      await f.membership.consume(uid, 'youtube', nonceHash);
      await f.membershipCsv.withMember(member(1).channelId, async (value, options) => {
        assert.equal(options.refreshAccount, true);
        assert.equal(value, null); const writer = await f.transition.route();
        await assert.rejects(f.transition.beginExternal(writer, id(), ['csv/control']), { code: 'WRITER_RESOURCE_BUSY' });
        await f.membership.complete(uid, 'youtube', nonceHash, { status: 'none', type: 'csv', levelName: '일반', userChannelId: member(1).channelId, verificationVersion: 2, verificationProvider: 'youtube', lastChecked: Date.now() });
      });
    });
    assert(replaced); assert.equal((await f.transition.inspect()).unresolved, 0);
  } finally { await f.close(); }
});
test('콜드 동일 버전은 무결성 root 준비를 공유하고 이후 조회는 전체 후보를 읽지 않는다', async () => {
  const f = await setup(); try {
    await f.publish([member(1), member(3), member(5)]);
    const pointer = (await f.csvAdapters.rtdb.inspect('csv/control')).entry.value.active;
    const lookup = createMembershipCsvLookup({ database: f.c.targetDatabase }); let reads = 0;
    const read = async () => { reads++; return (await f.csvAdapters.rtdb.inspect(`csv/candidate/${pointer.revision}`)).entry.value; };
    await Promise.all([lookup.read(pointer, member(1).channelId, read), lookup.read(pointer, member(3).channelId, read)]);
    assert.equal(reads, 1);
    for (let i = 0; i < 3; i++) await lookup.read(pointer, member(i).channelId, () => assert.fail('전체 목록 재조회 금지'));
  } finally { await f.close(); }
});

test('기존 활성 목록의 보조 색인 준비는 명시한 버전만 다루며 원본/포인터를 변경하지 않는다', async () => {
  const f = await setup(); try {
    const version = await f.publish([member(1), member(3)]);
    await f.c.targetDatabase.ref(`membershipCsvLookup/${version}`).remove();
    const before = await f.csvAdapters.rtdb.inspect('csv/control'), source = await f.csvAdapters.rtdb.inspect(`csv/candidate/${version}`);
    const plan = await f.membershipCsv.prepareActiveLookup({ dryRun: true });
    assert.equal(plan.count, 2); assert.equal((await f.c.targetDatabase.ref(`membershipCsvLookup/${version}`).get()).exists(), false);
    await assert.rejects(f.membershipCsv.prepareActiveLookup({ dryRun: false, revision: id(), fingerprint: plan.fingerprint }), { code: 'MEMBERSHIP_CSV_CONFLICT' });
    await f.membershipCsv.prepareActiveLookup({ dryRun: false, revision: plan.revision, fingerprint: plan.fingerprint });
    assert.deepEqual(await f.csvAdapters.rtdb.inspect('csv/control'), before);
    assert.deepEqual(await f.csvAdapters.rtdb.inspect(`csv/candidate/${version}`), source);
    assert((await f.c.targetDatabase.ref(`membershipCsvLookup/${version}`).get()).exists());
    assert.equal((await f.transition.inspect()).unresolved, 0);
  } finally { await f.close(); }
});

test('콜드 원본 지문 불일치·잘못된 색인 형식은 거부하고 활성 버전 변경은 다시 읽는다', async () => {
  const f = await setup(); try {
    await f.publish([member(1), member(3)]);
    const pointer = (await f.csvAdapters.rtdb.inspect('csv/control')).entry.value.active;
    const source = (await f.csvAdapters.rtdb.inspect(`csv/candidate/${pointer.revision}`)).entry.value;
    const lookup = createMembershipCsvLookup({ database: f.c.targetDatabase });
    const corrupt = structuredClone(source); corrupt.members[0].levelName = '위조';
    await assert.rejects(lookup.read(pointer, member(1).channelId, async () => corrupt));
    const head = f.c.targetDatabase.ref(`membershipCsvLookup/${pointer.revision}/${pointer.fingerprint}/head`);
    await head.child('format').set(99);
    await assert.rejects(lookup.read(pointer, member(1).channelId, async () => source), { code: 'CSV_WRITER_LOOKUP_INVALID' });
    await head.child('format').set(1);
    const adapter = f.csvAdapters.rtdb, original = adapter.lookupMember;
    let changed = false, release;
    const gate = new Promise(resolve => { release = resolve; });
    // 독립 요청은 읽기 요청의 AsyncLocalStorage 문맥을 상속하지 않는다.
    const replacement = (async () => { await gate; await f.publish([member(5)]); })();
    adapter.lookupMember = async (...args) => {
      const value = await original(...args);
      if (!changed) { changed = true; release(); await replacement; }
      return value;
    };
    assert.equal(await f.membershipCsv.readMemberSummary(member(1).channelId), null);
    assert(changed); assert.equal((await f.transition.inspect()).unresolved, 0);
  } finally { await f.close(); }
});
