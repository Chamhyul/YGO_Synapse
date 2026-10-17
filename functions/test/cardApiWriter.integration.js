'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, createHash } = require('node:crypto');
const { FieldValue } = require('firebase-admin/firestore');
const express = require('express');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const { open } = require('../../integration/user-migration/connection.cjs');
const { createUserInventoryWriterBinding } = require('../services/userInventoryWriterRepository');
const { newKey, createCardApiAccess } = require('../services/cardApiAccess');
const { createApiAccessStore } = require('../services/user-storage/apiAccessStore');
const { createWriterCardInfoHandler } = require('../services/cardApiWriterHttp');
const { encodeKey } = require('../services/user-storage/codec');
const { getCardApiAccess } = require('../services/cardApiAccessRepository');
const id = () => randomBytes(16).toString('hex'), origin = 'https://synthetic-writer.example';
const migration = { prepareInventoryV2: async () => {}, inventoryMigrationStatus: () => ({ status: 'complete' }) };
const options = extra => ({ label: '합성 전환 키', origins: [origin], minuteLimit: 5, dayLimit: 20, ...extra });
async function setup(extra = {}, runId = id(), runtime = false) {
  const connection = open(runId);
  const db = runtime ? { collection: name => connection.db.collection('unused').firestore.collection(`profileWriterRuns/${runId}/${name}`), runTransaction: action => connection.db.runTransaction(action) } : connection.db;
  const database = runtime ? { ref: name => connection.database.ref(`profileWriterRuns/${runId}/data/${name}`) } : connection.targetDatabase;
  const binding = createUserInventoryWriterBinding({ db, database, bucket: connection.bucket, FieldValue, runId, migration, config: connection.config, ...extra });
  await binding.initialize();
  return { ...binding, db, database, runId, connection, close: () => connection.close() };
}
async function flip(f) { const writer = await f.transition.route(); await f.transition.copy(writer); await f.transition.drain(writer); return f.transition.activate(writer); }
const environment = f => ({ ...process.env, USER_PROFILE_WRITER_MODE: 'emulator', USER_PROFILE_WRITER_RUN_ID: f.runId });
async function usage(f, key) { return (await f.apiAdapters[(await f.transition.route()).backend].read(`apiKey/${key.id}`)).value.usage; }
async function server(f, read = async () => ({ id: '123', data: () => ({ info: { ko: { name: '합성 카드', ciid: [1] }, atk: 0 } }) })) {
  const app = express(); app.all('/card', createWriterCardInfoHandler({ writerBinding: f, env: environment(f), read }));
  const listener = app.listen(0, '127.0.0.1'); await once(listener, 'listening');
  return { url: `http://127.0.0.1:${listener.address().port}/card`, close: () => new Promise(resolve => { listener.close(resolve); listener.closeAllConnections(); }) };
}
test('기존 FS 키·사용량·CORS는 프로필과 같은 epoch로 양방향 전환하고 교체·중지를 재생한다', async () => {
  const f = await setup(), key = newKey();
  try {
    const original = createCardApiAccess(f.db); await original.register(key, options()); await original.consume(key.token, origin);
    await f.repository.updateSettings('synthetic-profile', { theme: 'dark' });
    await flip(f); assert.equal((await f.apiAccess.authenticate(key.token)).id, key.id); assert.equal(await f.apiAccess.allowsPreflight(origin), true);
    assert.equal((await f.apiAccess.consume(key.token, origin)).dayRemaining, 18);
    const rotated = newKey(key.id); await f.apiAccess.rotate(rotated);
    await assert.rejects(f.apiAccess.authenticate(key.token), { code: 'API_KEY_INVALID' });
    assert.equal((await f.apiAccess.consume(rotated.token, origin)).dayRemaining, 17);
    await f.apiAccess.disable(key.id); assert.equal(await f.apiAccess.allowsPreflight(origin), false);
    await flip(f); await assert.rejects(original.authenticate(rotated.token), { code: 'API_KEY_DISABLED' });
    assert.equal(await original.allowsPreflight(origin), false); assert.equal((await f.db.collection('cardApiUsage').doc(key.id).get()).data().dayCount, 3);
    assert.equal((await f.repository.read('synthetic-profile')).value.settings.theme, 'dark');
    const journal = JSON.stringify((await f.database.ref('profileWriterTransitions').get()).val());
    assert.equal(journal.includes(key.token) || journal.includes(rotated.token) || journal.includes(key.token.split('.')[1]), false, '원문 키를 변경 기록에 보관하지 않습니다.');
  } finally { await f.close(); }
});
for (const backend of ['legacy', 'rtdb']) test(`${backend} 두 SDK의 동시 소비는 한도까지만 집계하고 unlimited 기간만 면제한다`, async () => {
  const f = await setup(), other = await setup({}, f.runId), key = newKey();
  try { if (backend === 'rtdb') await flip(f); await f.apiAccess.register(key, options({ minuteLimit: 'unlimited', dayLimit: 3 }));
    const results = await Promise.allSettled([f.apiAccess.consume(key.token, origin), other.apiAccess.consume(key.token, origin), f.apiAccess.consume(key.token, origin), other.apiAccess.consume(key.token, origin)]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 3);
    const error = results.find(result => result.status === 'rejected').reason; assert.equal(error.status, 429); assert.ok(error.retryAfter > 0);
    for (const result of results.filter(result => result.status === 'fulfilled')) assert.equal(result.value.minuteRemaining, 'unlimited');
    assert.equal((await usage(f, key)).minuteCount, 3); assert.equal((await usage(f, key)).dayCount, 3);
  } finally { await other.close(); await f.close(); }
});
for (const backend of ['legacy', 'rtdb']) test(`${backend} 카드 HTTP 오류·CORS·쿼터 헤더와 카드 읽기 범위를 유지한다`, async () => {
  const f = await setup(), key = newKey(); let web, reads = 0;
  try { if (backend === 'rtdb') await flip(f); await f.apiAccess.register(key, options({ minuteLimit: 2 }));
    await f.db.collection('cards').doc('123').set({ info: { ko: { name: '합성 카드', ciid: [1] }, atk: 0 } });
    web = await server(f, async input => { reads++; return input.value === '123' ? f.db.collection('cards').doc(input.value).get() : null; });
    const headers = { 'X-API-Key': key.token, Origin: origin };
    const preflight = await fetch(web.url, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'X-API-Key' } });
    assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), origin); assert.equal(await usage(f, key), null);
    for (const [url, header, expected, code] of [[`${web.url}?cid=123`, {}, 401, 'API_KEY_INVALID'], [`${web.url}?cid=123`, { ...headers, Origin: 'https://other.example' }, 403, 'ORIGIN_NOT_ALLOWED'], [`${web.url}?cid=0`, headers, 400, 'INVALID_QUERY']]) {
      const res = await fetch(url, { headers: header }); assert.equal(res.status, expected); assert.equal((await res.json()).code, code);
    }
    assert.equal(await usage(f, key), null);
    const success = await fetch(`${web.url}?cid=123&locale=ko`, { headers }); assert.equal(success.status, 200);
    assert.deepEqual(await success.json(), { success: true, cid: '123', locales: { ko: { name: '합성 카드', ciid: [1] } }, stats: { atk: 0 } });
    assert.equal(success.headers.get('X-RateLimit-Remaining-Minute'), '1'); assert.equal(success.headers.get('Cache-Control'), 'private, no-store');
    const missing = await fetch(`${web.url}?cid=999`, { headers }); assert.equal(missing.status, 404); assert.equal((await missing.json()).code, 'CARD_NOT_FOUND');
    const limited = await fetch(`${web.url}?cid=123`, { headers }); assert.equal(limited.status, 429); assert.ok(Number(limited.headers.get('Retry-After')) > 0);
    assert.equal(reads, 2); assert.equal((await usage(f, key)).dayCount, 2); assert.equal((await f.db.collection('cards').get()).size, 1);
  } finally { await web?.close(); await f.close(); }
});
for (const backend of ['legacy', 'rtdb']) test(`${backend} 소비 응답 유실은 native receipt로 복구하고 재차 차감하지 않는다`, async () => {
  let lost = false, opId; const f = await setup({ onCheckpoint: async (stage, value) => {
    if (lost && stage === 'businessCommitted') { lost = false; opId = value; throw new Error('합성 승인 응답 유실'); }
  } }), key = newKey();
  try { if (backend === 'rtdb') await flip(f); await f.apiAccess.register(key, options()); lost = true;
    await assert.rejects(f.apiAccess.consume(key.token, origin)); assert.equal((await f.transition.inspect()).unresolved, 1);
    const fresh = await setup({}, f.runId); try { assert.equal((await fresh.transition.recover(opId)).dayRemaining, 19); } finally { await fresh.close(); }
    await f.apiAccess.consume(key.token, origin); assert.equal((await f.transition.recover(opId)).dayRemaining, 19);
    assert.equal((await usage(f, key)).dayCount, 2); await flip(f); assert.equal((await usage(f, key)).dayCount, 2);
  } finally { await f.close(); }
});
for (const backend of ['legacy', 'rtdb']) test(`${backend} 지연된 소비 RPC는 새 SDK의 영구 취소를 우회하지 않는다`, async () => {
  const f = await setup(), fresh = await setup({}, f.runId), key = newKey(); let release, entered, op;
  const gate = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { entered = resolve; });
  try { if (backend === 'rtdb') await flip(f); await f.apiAccess.register(key, options());
    const adapter = f.apiAdapters[backend], commit = adapter.commit;
    adapter.commit = async value => { op = value; entered(); await gate; return commit(value); };
    const pending = f.apiAccess.consume(key.token, origin); await ready;
    assert.equal((await fresh.transition.fenceUncommitted(op.id)).status, 'cancelled'); release();
    await assert.rejects(pending, { code: 'WRITER_CANCELLED' }); assert.equal(await usage(f, key), null); await flip(f); assert.equal(await usage(f, key), null);
  } finally { release?.(); await fresh.close(); await f.close(); }
});
for (const backend of ['legacy', 'rtdb']) test(`${backend} 실제 승인 직전 만료와 UTC 창 변경을 재검사한다`, async () => {
  let at = Date.now(), mode; const f = await setup({ apiClock: () => at }), key = newKey();
  try { if (backend === 'rtdb') await flip(f); await f.apiAccess.register(key, options({ expiresAt: at + 120000 }));
    const prepare = f.transition.prepare; f.transition.prepare = async (...args) => { const op = await prepare(...args);
      if (args[4]?.details.action === 'consume' && mode) { const current = mode; mode = null; at = current === 'minute' ? (Math.floor(at / 60000) + 1) * 60000 : at + 120000; } return op; };
    mode = 'minute'; await f.apiAccess.consume(key.token, origin); assert.equal((await usage(f, key)).minute, Math.floor(at / 60000));
    mode = 'expiry'; await assert.rejects(f.apiAccess.consume(key.token, origin), { code: 'API_KEY_DISABLED' }); assert.equal((await usage(f, key)).dayCount, 1);
    assert.equal(await f.apiAccess.allowsPreflight(origin), true, '만료 키 OPTIONS 계약은 중지 전까지 유지합니다.');
  } finally { await f.close(); }
});
test('카드 조회가 진행 중이면 중지·전환이 요청 완료를 앞지르지 않는다', async () => {
  const f = await setup(), key = newKey(); let release, entered, web;
  const gate = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { entered = resolve; });
  try { await f.apiAccess.register(key, options()); web = await server(f, async () => { entered(); await gate; return { id: '123', data: () => ({ info: {} }) }; });
    const pending = fetch(`${web.url}?cid=123`, { headers: { 'X-API-Key': key.token } }); await ready;
    const writer = await f.transition.route(); await f.transition.copy(writer); await f.transition.drain(writer);
    await assert.rejects(f.transition.activate(writer), { code: 'WRITER_NOT_DRAINED' });
    release(); assert.equal((await pending).status, 200); await f.transition.activate(writer); await f.apiAccess.disable(key.id);
    assert.equal((await fetch(`${web.url}?cid=123`, { headers: { 'X-API-Key': key.token } })).status, 403);
  } finally { release?.(); await web?.close(); await f.close(); }
});
for (const backend of ['legacy', 'rtdb']) test(`${backend} 실제 DB transaction 콜백 전 만료는 사용량을 차감하지 않는다`, async () => {
  let at = Date.now(); const f = await setup({ apiClock: () => at }), key = newKey();
  try { if (backend === 'rtdb') await flip(f); await f.apiAccess.register(key, options({ expiresAt: at + 60000 }));
    if (backend === 'legacy') {
      const tx = f.db.runTransaction; let once = true;
      f.db.runTransaction = action => tx(async transaction => {
        const get = transaction.get.bind(transaction); transaction.get = ref => {
          if (once && ref.path.includes('/apiAccessWriterReceipts/')) { once = false; at += 60000; } return get(ref);
        }; return action(transaction);
      });
    } else {
      const ref = f.database.ref; let once = true;
      f.database.ref = name => { const target = ref(name), transaction = target.transaction.bind(target);
        target.transaction = (...args) => { if (once && name.startsWith('apiAccess/keys/')) { once = false; at += 60000; } return transaction(...args); }; return target; };
    }
    await assert.rejects(f.apiAccess.consume(key.token, origin), { code: 'API_KEY_DISABLED' }); assert.equal(await usage(f, key), null);
  } finally { await f.close(); }
});
test('복사 중 발급·소비·중지의 변경을 재생하고 여러 키의 동일 Origin을 유지한다', async () => {
  const f = await setup(), a = newKey(), b = newKey();
  try { await f.apiAccess.register(a, options()); const writer = await f.transition.route(); await f.transition.copy(writer);
    await f.apiAccess.register(b, options()); await f.apiAccess.consume(a.token, origin); await f.apiAccess.disable(a.id);
    await f.transition.drain(writer); await f.transition.activate(writer);
    assert.equal(await f.apiAccess.allowsPreflight(origin), true); await f.apiAccess.consume(b.token, origin);
    await f.apiAccess.disable(b.id); assert.equal(await f.apiAccess.allowsPreflight(origin), false); await flip(f);
    assert.equal((await f.db.collection('cardApiUsage').doc(a.id).get()).data().dayCount, 1);
    assert.equal((await f.db.collection('cardApiUsage').doc(b.id).get()).data().dayCount, 1);
    assert.equal(await createCardApiAccess(f.db).allowsPreflight(origin), false);
  } finally { await f.close(); }
});
test('한 요청의 동시 키 조회는 잠금 등록을 직렬화하고 미종료 장벽을 남기지 않는다', async () => {
  const f = await setup(), keys = [newKey(), newKey()];
  try { for (const key of keys) await f.apiAccess.register(key, options());
    await f.apiAccess.withRequest(null, () => Promise.all(keys.map(key => f.apiAccess.authenticate(key.token))));
    assert.equal((await f.transition.inspect()).unresolved, 0); await flip(f);
  } finally { await f.close(); }
});
test('요청 잠금 종료 응답 유실은 성공 본문·쿼터 헤더를 전송하지 않고 전환 장벽을 유지한다', async () => {
  const f = await setup(), key = newKey(); let web;
  try { await f.apiAccess.register(key, options()); const end = f.transition.endExternal; f.transition.endExternal = async () => { throw new Error('합성 요청 종료 실패'); };
    web = await server(f); const result = await fetch(`${web.url}?cid=123`, { headers: { 'X-API-Key': key.token } });
    assert.equal(result.status, 503); assert.deepEqual(await result.json(), { success: false, code: 'API_UNAVAILABLE' }); assert.equal(result.headers.get('X-RateLimit-Remaining-Minute'), null);
    assert.equal((await f.transition.inspect()).unresolved, 1); assert.equal((await usage(f, key)).dayCount, 1); f.transition.endExternal = end;
  } finally { await web?.close(); await f.close(); }
});
test('관리 대상의 불일치·고아 usage/CORS·알 수 없는 FS 자료는 원본을 지우지 않고 이전을 거부한다', async () => {
  for (const kind of ['usage', 'cors', 'extra']) {
    const f = await setup(), key = newKey();
    try { if (kind === 'usage') await f.db.collection('cardApiUsage').doc(key.id).set({ minute: 1, day: 1, minuteCount: 1, dayCount: 1 });
      else if (kind === 'cors') await f.db.collection('cardApiConfig').doc('cors').set({ keyOrigins: { [key.id]: [origin] } });
      else { await createCardApiAccess(f.db).register(key, options()); await f.db.collection('cardApiKeys').doc(key.id).update({ unknown: true }); }
      const before = await f.db.collection(kind === 'usage' ? 'cardApiUsage' : kind === 'cors' ? 'cardApiConfig' : 'cardApiKeys').get();
      await assert.rejects(f.transition.copy(await f.transition.route())); assert.equal((await f.db.collection(before.docs[0].ref.parent.id).get()).size, before.size);
    } finally { await f.close(); }
  }
});
test('구형 RTDB writer는 공통 receipt head를 덮어쓰지 못하고 잘못된 후보는 허용하지 않는다', async () => {
  const f = await setup(), key = newKey();
  try { await flip(f); await f.apiAccess.register(key, options());
    await assert.rejects(createApiAccessStore({ database: f.database }).consume(key.token, origin));
    assert.equal(await usage(f, key), null);
    const hash = createHash('sha256').update(origin).digest('hex'); await f.database.ref(`apiAccess/origins/${hash}/${key.id}`).set(false);
    await assert.rejects(f.apiAccess.allowsPreflight(origin), { code: 'API_WRITER_MIGRATION_REQUIRED' });
  } finally { await f.close(); }
});
test('새 SDK 기본 RTDB 자료도 후보 승인 확인 후 공통 경계로 읽고 재생한다', async () => {
  const f = await setup(), key = newKey();
  try { await flip(f); await createApiAccessStore({ database: f.database }).register(key, options());
    assert.equal(await f.apiAccess.allowsPreflight(origin), true); await f.apiAccess.consume(key.token, origin); await flip(f);
    assert.equal((await createCardApiAccess(f.db).consume(key.token, origin)).dayRemaining, 18);
  } finally { await f.close(); }
});
test('명시 selector는 run/접속 설정 변경과 원격 카드 읽기를 캐시에서도 거부한다', async () => {
  const f = await setup(), key = newKey();
  try { const env = environment(f), access = getCardApiAccess({ env, writerBinding: f }); await access.register(key, options());
    env.FIRESTORE_EMULATOR_HOST = 'emulators:8081'; await assert.rejects(access.authenticate(key.token), { code: 'USER_STORAGE_CONFIG_INVALID' });
    for (const override of [{ USER_PROFILE_WRITER_RUN_ID: id() }, { CARD_SERVICE_URL: 'https://synthetic.invalid' }, { USER_STORAGE_BACKEND: 'storage' }])
      assert.throws(() => getCardApiAccess({ env: { ...environment(f), ...override }, writerBinding: f }), { code: 'USER_STORAGE_CONFIG_INVALID' });
  } finally { await f.close(); }
});
test('writer CLI는 별도 프로세스의 발급·교체·중지를 같은 run/epoch에 연결하고 원문 출력 없이 사용량을 유지한다', { timeout: 60000 }, async () => {
  const f = await setup({}, id(), true), dir = await fs.mkdtemp(path.join(os.tmpdir(), 'api-writer-cli-'));
  const env = environment(f), script = path.resolve(__dirname, '../../scripts/manage_card_api_keys.js');
  async function run(args) {
    const result = await execFile(process.execPath, [script, ...args], { env, timeout: 20000, maxBuffer: 32768 });
    assert.equal(/ygo_[a-f0-9]{24}\.[A-Za-z0-9_-]{43}/.test(result.stdout + result.stderr), false, '키 원문은 출력하지 않습니다.');
  }
  try { const out = path.join(dir, 'issued.json'), rotatedOut = path.join(dir, 'rotated.json');
    await run(['issue', '--writer-emulator', '--label', '합성 CLI', '--out', out]); await assert.rejects(fs.stat(out), { code: 'ENOENT' });
    await run(['issue', '--writer-emulator', '--apply', '--label', '합성 CLI', '--out', out, '--origin', origin]);
    const issued = JSON.parse(await fs.readFile(out, 'utf8')); assert.equal((await fs.stat(out)).mode & 0o777, 0o600); assert.equal(issued.target, 'writer-emulator');
    await f.apiAccess.consume(issued.apiKey, origin); await flip(f);
    await run(['rotate', '--writer-emulator', '--apply', '--id', issued.id, '--out', rotatedOut]);
    const rotated = JSON.parse(await fs.readFile(rotatedOut, 'utf8')); await assert.rejects(f.apiAccess.authenticate(issued.apiKey), { code: 'API_KEY_INVALID' });
    assert.equal((await f.apiAccess.consume(rotated.apiKey, origin)).dayRemaining, 4998);
    await run(['disable', '--writer-emulator', '--apply', '--id', issued.id]); await flip(f);
    await assert.rejects(f.apiAccess.authenticate(rotated.apiKey), { code: 'API_KEY_DISABLED' }); assert.equal(await f.apiAccess.allowsPreflight(origin), false);
  } finally { await fs.rm(dir, { recursive: true, force: true }); await f.close(); }
});
