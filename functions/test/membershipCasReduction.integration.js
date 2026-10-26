'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { randomBytes, createHash } = require('node:crypto');
const { fixture, call } = require('./commonWriterFixture.cjs');
const { createWriterJournalStore } = require('../services/user-storage/writerJournalStore');
const { syncProviderMembershipClaims } = require('../services/membershipProviderRuntime');
const id = () => randomBytes(16).toString('hex');
const member = provider => ({ status: 'active', type: provider === 'discord' ? 'discord' : 'csv', levelName: 'synthetic',
  verificationVersion: 2, verificationProvider: provider, lastChecked: Date.now(),
  ...(provider === 'discord' ? { discordId: '123456789012345678' } : { userChannelId: 'UC' + 'x'.repeat(22) }) });
async function setup(backend = 'rtdb') {
  const f = await fixture(); await f.binding.transition.initialize();
  if (backend === 'rtdb') { const w = await f.binding.transition.route(); await f.binding.transition.copy(w); await f.binding.transition.drain(w); await f.binding.transition.activate(w); }
  let count = 0, commits = 0, fault, faultAt, first, tracking = false;
  const database = f.connection.targetDatabase, ref = database.ref.bind(database);
  database.ref = path => {
    const target = ref(path);
    return new Proxy(target, { get(object, key) {
      if (key === 'transaction' && /^profileWriterTransitions\/[^/]+$/.test(path)) return async (...args) => {
        const n = tracking ? ++count : 0;
        if (n === faultAt && fault === 'before') throw Error('synthetic-before-cas');
        const saved = await target.transaction(...args);
        if (n === 1) first = (await createWriterJournalStore({ database: { ref } }).read(f.config.runId)).value;
        if (n === faultAt && fault === 'after') throw Object.assign(Error('synthetic-cas-ack-loss'), { code: 'USER_STORAGE_WRITE_AMBIGUOUS' });
        return saved;
      };
      const value = Reflect.get(object, key, object); return typeof value === 'function' ? value.bind(object) : value;
    } });
  };
  const adapter = f.binding.stores[backend], commit = adapter.commit;
  adapter.commit = async (...args) => { if (tracking) commits++; return commit(...args); };
  const journal = createWriterJournalStore({ database: { ref } });
  return { ...f, adapter, stats: () => ({ count, commits, first }), state: async () => (await journal.read(f.config.runId)).value,
    fault(stage, at) { fault = stage; faultAt = at; },
    async track(action) { count = 0; commits = 0; tracking = true; try { return await action(); } finally { tracking = false; } },
    async verify(provider, action, { deferClaims = true, localOnly = false } = {}) {
      const nonceHash = createHash('sha256').update(id()).digest('hex'), now = Date.now();
      await f.binding.membership.start(f.uid, provider, { nonceHash, startedAt: now, expiresAt: now + 300000,
        consumed: false, localOnly, ...(provider === 'discord' ? { redirectUri: 'https://ygo-synapse.web.app/' } : {}) });
      count = 0; commits = 0; tracking = true;
      try { return await f.binding.membership.withVerification(f.uid, provider, async () => {
        const consumed = await f.binding.membership.consume(f.uid, provider, nonceHash); assert.equal(consumed.consumed, true);
        assert(f.binding.membership.writerLease());
        if (provider === 'youtube') await f.binding.transition.addExternalResources(f.binding.membership.writerLease().id, ['csv/control']);
        if (action) return action({ nonceHash, consumed });
        return f.binding.membership.complete(f.uid, provider, nonceHash, member(provider));
      }, { consume: { nonceHash }, deferClaims }); }
      finally { tracking = false; }
    },
  };
}
for (const provider of ['discord', 'youtube']) for (const backend of ['legacy', 'rtdb']) test(`${backend}/${provider}: 합성 등록·확정은 native 저장2회와 복구·전환 계약을 보존한다`, async () => {
  const f = await setup(backend);
  try {
    let nonce;
    const saved = await f.verify(provider, async ({ nonceHash }) => {
      nonce = nonceHash;
      const value = await f.binding.membership.complete(f.uid, provider, nonceHash, member(provider));
      if (backend === 'rtdb') {
        assert.equal(f.binding.membership.writerLease(), undefined);
        assert.equal(f.binding.membership.verificationWriter().backend, 'rtdb');
        assert.deepEqual(await syncProviderMembershipClaims(f.uid, { deferClaims: true, config: f.config, storage: f.binding.claimsStorage }, {}, () => assert.fail('동기 claims 쓰기 금지')),
          { claimsPending: true, membershipClaims: { status: 'pending' } });
      } else assert(f.binding.membership.writerLease(), '동기 claims는 완료 후에도 잠금을 유지한다');
      return value;
    });
    assert.equal(saved.stored, true); assert.equal(f.stats().commits, 2);
    assert.equal(f.stats().count, (backend === 'rtdb' ? 4 : 5) + Number(provider === 'youtube'));
    const first = f.stats().first, consume = Object.values(first.operations).find(op => op.details?.action === 'consume');
    assert.equal(consume.status, 'executing'); assert.equal(first.external[consume.parentExternal].status, 'running');
    assert.equal((await f.binding.transition.inspect()).unresolved, 0);
    await assert.rejects(f.binding.membership.consume(f.uid, provider, nonce), { code: 'MEMBERSHIP_VERIFICATION_EXPIRED' });
    for (let n = 0; n < 2; n++) { const w = await f.binding.transition.route(); await f.binding.transition.copy(w); await f.binding.transition.drain(w); await f.binding.transition.activate(w); }
    assert.equal((await f.binding.membership.read(f.uid)).membership.verificationProvider, provider);
  } finally { await f.close(); }
});
test('RTDB 동기 claims 모드와 localOnly는 기존 보호 범위를 보존한다', async () => {
  const f = await setup();
  try {
    await f.verify('discord', async ({ nonceHash }) => {
      await f.binding.membership.complete(f.uid, 'discord', nonceHash, member('discord'));
      assert(f.binding.membership.writerLease());
    }, { deferClaims: false });
    assert.equal(f.stats().count, 5);
    assert.equal((await f.verify('youtube', undefined, { localOnly: true })).stored, false);
    assert.equal(f.stats().count, 5); assert.equal((await f.binding.transition.inspect()).unresolved, 0);
  } finally { await f.close(); }
});
for (const stage of ['before', 'after']) for (const at of [1, 4]) test(`합성 CAS${at} ${stage} 실패는 OAuth·native 재제출 없이 기존 영수증/fence로 복구한다`, async () => {
  const f = await setup(); let actions = 0;
  try {
    f.fault(stage, at);
    await assert.rejects(f.verify('discord', async ({ nonceHash }) => { actions++; return f.binding.membership.complete(f.uid, 'discord', nonceHash, member('discord')); }));
    f.fault(null);
    if (at === 1) { assert.equal(actions, 0); assert.equal(f.stats().commits, 0); }
    else { assert.equal(actions, 1); assert.equal(f.stats().commits, 2); }
    let state = await f.state(); const w = await f.binding.transition.route(); await f.binding.transition.drain(w);
    for (const op of Object.values(state.operations).filter(op => op.status === 'executing')) {
      const receipt = await f.adapter.receipt(op);
      if (receipt) await f.binding.transition.recover(op.id); else await f.binding.transition.fenceUncommitted(op.id);
    }
    state = await f.state();
    for (const parent of Object.values(state.external || {}).filter(op => ['running', 'uncertain'].includes(op.status))) {
      const settled = Object.values(state.operations).find(op => op.parentExternal === parent.id);
      const recovery = await f.binding.transition.recoverExternal(parent.id, id(), parent.resources, { writersDrained: true,
        ...(settled ? { settledOperation: { id: settled.id, digest: settled.digest } } : {}) });
      await f.binding.transition.endExternal(recovery);
    }
    assert.equal((await f.binding.transition.inspect()).unresolved, 0);
  } finally { await f.close(); }
});
test('소비 승인 후 drain은 새 요청을 막고 등록된 완료와 역전환을 허용한다', async () => {
  const f = await setup();
  try {
    await f.verify('discord', async ({ nonceHash }) => {
      const w = await f.binding.transition.route(); await f.binding.transition.copy(w); await f.binding.transition.drain(w);
      await assert.rejects(f.binding.transition.activate(w), { code: 'WRITER_NOT_DRAINED' });
      return f.binding.membership.complete(f.uid, 'discord', nonceHash, member('discord'));
    });
    const w = await f.binding.transition.route(); await f.binding.transition.activate(w);
    assert.equal((await f.binding.membership.read(f.uid)).membership.status, 'active');
  } finally { await f.close(); }
});
test('계정만 잠근 claims 요청과도 충돌하며 잠금 해제 뒤 새 문맥으로 한 번만 검증한다', async () => {
  const f = await setup(); const { accountResource } = require('../services/user-storage/accountResource');
  let busy = 0, actions = 0;
  try {
    const now = Date.now(), nonceHash = createHash('sha256').update(id()).digest('hex');
    await f.binding.membership.start(f.uid, 'discord', { nonceHash, startedAt: now, expiresAt: now + 300000,
      consumed: false, localOnly: false, redirectUri: 'https://ygo-synapse.web.app/' });
    const writer = await f.binding.transition.route(), holder = id();
    await f.binding.transition.beginExternal(writer, holder, [accountResource(f.uid)]);
    const prepare = f.binding.transition.prepareAndExecuteMembershipWithReceipt;
    f.binding.transition.prepareAndExecuteMembershipWithReceipt = async (...args) => {
      try { return await prepare(...args); }
      catch (error) {
        if (error.code === 'WRITER_RESOURCE_BUSY') {
          busy++; assert.equal(actions, 0);
          const state = await f.state(); assert.equal(state.external[args[4].parentExternal], undefined);
          await f.binding.transition.endExternal(holder);
        }
        throw error;
      }
    };
    await f.binding.membership.withVerification(f.uid, 'discord', async () => {
      actions++; await f.binding.membership.consume(f.uid, 'discord', nonceHash);
      await f.binding.membership.complete(f.uid, 'discord', nonceHash, member('discord'));
    }, { consume: { nonceHash }, deferClaims: true });
    assert.equal(busy, 1); assert.equal(actions, 1); assert.equal((await f.binding.transition.inspect()).unresolved, 0);
  } finally { await f.close(); }
});
test('합성 등록 용량 부족은 부모·명령을 함께 거부하고 native RPC를 제출하지 않는다', async () => {
  const f = await setup();
  try {
    const { createUserWriterTransition } = require('../services/userWriterTransition');
    const journal = createWriterJournalStore({ database: f.connection.targetDatabase }), runId = id();
    const tool = createUserWriterTransition({ journal, runId, stores: f.binding.stores, checkKey() {}, maxOperations: 1 });
    const writer = await tool.initialize(), now = Date.now(), parent = id(), operation = id();
    const nonce = { key: `verification/discord/${f.uid}`, exists: true, token: '0', value: {
      nonceHash: 'a'.repeat(64), startedAt: now, expiresAt: now + 300000, consumed: true, completed: false,
      profileGeneration: 0, localOnly: false, redirectUri: 'https://ygo-synapse.web.app/' } };
    await assert.rejects(tool.prepareAndExecuteMembershipWithReceipt(writer, operation, [nonce], nonce.value,
      { resources: [`fs/users/${f.uid}`, `inventory/${f.uid}`], details: { kind: 'membership', action: 'consume', profileToken: '0' },
        parentExternal: parent, admitParent: true }), { code: 'WRITER_JOURNAL_FULL' });
    const state = (await journal.read(runId)).value;
    assert.equal(state.external?.[parent], undefined); assert.equal(state.operations[operation], undefined); assert.equal(f.stats().commits, 0);
  } finally { await f.close(); }
});

for (const provider of ['discord', 'youtube']) test(`HTTP ${provider}: 실제 선택 코드의 별도 claims 모드는 합성 CAS와 기존 응답·일회 소비를 유지한다`, async () => {
  const f = await setup();
  try {
    f.env.MEMBERSHIP_CLAIMS_MODE = 'deferred';
    await f.binding.repository.completeRegistration(f.uid, { terms: 'synthetic', privacy: 'synthetic' });
    await f.binding.repository.updateSettings(f.uid, { theme: 'dark' });
    if (provider === 'youtube') {
      const service = require('../services/membershipCsvService').createMembershipCsvService({ store: f.binding.membershipCsv });
      const members = [{ channelId: member(provider).userChannelId, memberName: 'synthetic', levelName: 'synthetic' }];
      await service.apply({ members, ...await service.preview({ members }), operationId: id() }, f.owner);
    }
    const forbidden = () => assert.fail('실제 외부 연결·동기 claims 쓰기 금지');
    const utils = f.load('functions/utils/auth.js');
    const common = { env: f.env, storage: f.binding.claimsStorage, rtdbTestDependencies: true, auth: f.binding.auth,
      db: { collection: forbidden }, isLocal: forbidden, forward: forbidden, setCors() {}, verifyAppCheck: utils.verifyAppCheck,
      verifyRegisteredUser: utils.verifyRegisteredUser, syncClaims: forbidden };
    const title = provider === 'discord' ? 'Discord' : 'Youtube';
    const service = f.load(`functions/services/${provider}Membership.js`);
    const handlers = provider === 'discord' ? service.createDiscordMembershipHandlers({ ...common,
      clientId: 'synthetic', guildId: 'synthetic', getClientSecret: () => 'synthetic',
      getMembership: async () => ({ discordId: member(provider).discordId, roles: ['1462257396020809800'] }) })
      : service.createYoutubeMembershipHandlers({ ...common,
        fetchImpl: async () => ({ ok: true, json: async () => ({ items: [{ id: member(provider).userChannelId }] }) }) });
    const start = await call(handlers[`start${title}MembershipVerification`],
      { body: provider === 'discord' ? { redirectUri: 'https://ygo-synapse.web.app/' } : {} });
    assert.equal(start.statusCode, 200);
    const body = { verificationId: start.body.verificationId,
      ...(provider === 'discord' ? { code: 'synthetic' } : { accessToken: 'synthetic' }) };
    const saved = await f.track(() => call(handlers[`verify${title}Membership`], { body }));
    assert.equal(saved.statusCode, 200); assert.equal(saved.body.success, true); assert.equal(saved.body.claimsPending, true);
    assert.equal(saved.body.membershipClaims.status, 'pending'); assert.equal(saved.body.uid, f.uid);
    assert.equal(saved.body.sourceMembership.verificationProvider, provider); assert.equal(saved.body.isMemberActive, true);
    assert.equal(f.stats().count, provider === 'discord' ? 4 : 5); assert.equal(f.stats().commits, 2);
    assert.equal((await f.binding.repository.read(f.uid)).value.settings.theme, 'dark');
    const duplicate = await f.track(() => call(handlers[`verify${title}Membership`], { body }));
    assert.equal(duplicate.statusCode, 403); assert.equal(f.stats().count, 0); assert.equal(f.stats().commits, 0);
    assert.equal((await f.binding.transition.inspect()).unresolved, 0);
  } finally { await f.close(); }
});
test('합성 소비의 초기 사용자·journal 준비는 겹치고 두 작업 ID는 첫 CAS 전에 한 번씩 조회한다', async () => {
  const f = await setup(); let release, pending, timeout;
  const gate = new Promise(resolve => { release = resolve; });
  try {
    const now = Date.now(), nonceHash = createHash('sha256').update(id()).digest('hex');
    await f.binding.membership.start(f.uid, 'discord', { nonceHash, startedAt: now, expiresAt: now + 300000,
      consumed: false, localOnly: false, redirectUri: 'https://ygo-synapse.web.app/' });
    const database = f.connection.targetDatabase, ref = database.ref.bind(database), events = [];
    let nativeStarted = false, journalStarted = false, reserved;
    const prefetch = f.binding.transition.withOperationHistoryPrefetch;
    f.binding.transition.withOperationHistoryPrefetch = (ids, action) => { reserved = [...ids]; return prefetch(ids, action); };
    database.ref = path => {
      const target = ref(path);
      return new Proxy(target, { get(object, property) {
        const value = Reflect.get(object, property, object);
        if (property === 'get') return async (...args) => {
          events.push({ method: 'get', path });
          if (path.startsWith('users/')) { nativeStarted = true; await gate; }
          if (/^profileWriterTransitions\/[^/]+$/.test(path)) { journalStarted = true; assert(nativeStarted); release(); }
          return value.apply(object, args);
        };
        if (property === 'transaction') return (...args) => { events.push({ method: 'transaction', path }); return value.apply(object, args); };
        return typeof value === 'function' ? value.bind(object) : value;
      } });
    };
    pending = f.binding.membership.withVerification(f.uid, 'discord', async () => {
      await f.binding.membership.consume(f.uid, 'discord', nonceHash);
      return f.binding.membership.complete(f.uid, 'discord', nonceHash, member('discord'));
    }, { consume: { nonceHash }, deferClaims: true });
    await Promise.race([pending, new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('합성 준비 직렬 대기')), 5000); })]);
    assert(nativeStarted && journalStarted);
    const first = events.findIndex(e => e.method === 'transaction' && /^profileWriterTransitions\/[^/]+$/.test(e.path));
    const { encodeKey } = require('../services/user-storage/codec');
    for (const operation of reserved) {
      const matches = events.map((e, index) => ({ ...e, index })).filter(e => e.method === 'get' && e.path.endsWith(`/operations/${encodeKey(operation)}`));
      assert.equal(matches.length, 1); assert(matches[0].index < first);
    }
    assert.equal((await f.binding.transition.inspect()).unresolved, 0);
  } finally { clearTimeout(timeout); release(); await pending?.catch(() => {}); await f.close(); }
});
