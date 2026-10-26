'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { withAuthenticationResult, prepareAuthenticationResult } = require('../services/authenticationResult');
const { createUserWriterTransition } = require('../services/userWriterTransition');
const { createAdminPageHandler, createMemoryStore } = require('../services/adminPageSession');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function response() {
  const first = deferred(), frames = [], headers = {};
  return { first: first.promise, frames, headers, statusCode: 200, writableEnded: false,
    set(k, v) { headers[k] = v; return this; }, status(n) { this.statusCode = n; return this; },
    json(value) { this.body = value; return this; }, type() { return this; }, send(value) { this.body = value; return this; },
    write(line) { const frame = JSON.parse(line); frames.push(frame); first.resolve(frame); },
    end(line) { if (line) frames.push(JSON.parse(line)); this.writableEnded = true; } };
}
const req = { method: 'POST', body: { authenticationResultStream: true } };
function fixture({ commitError = false, invalidReceipt = false, recordError = false } = {}) {
  let state, receipt, committed = false;
  const gate = deferred(), reached = deferred();
  const journal = { read: async () => ({ exists: !!state, value: structuredClone(state) }),
    async update(_id, mutate) {
      const next = mutate(structuredClone(state)).value;
      if (Object.values(next.operations).some(op => op.status === 'completed')) {
        reached.resolve(); await gate.promise;
        if (recordError) throw Error('synthetic recording failure');
      }
      state = structuredClone(next); return { record: { value: structuredClone(state) } };
    } };
  const store = { snapshot: async () => [], apply: async () => {},
    async commit(op, confirm) {
      if (commitError) throw Error('synthetic business failure');
      committed = true;
      receipt = { id: op.id, digest: invalidReceipt ? 'f'.repeat(64) : op.digest,
        changes: op.changes.map(entry => ({ ...entry, token: '1' })), result: op.result };
      confirm(receipt);
    }, receipt: async () => receipt };
  const transition = createUserWriterTransition({ journal, stores: { legacy: store, rtdb: store },
    runId: 'a'.repeat(32), checkKey: value => value });
  return { transition, gate, reached, committed: () => committed, state: () => state };
}
for (const kind of ['membership', 'admin']) test(`${kind}: 확정 업무 저장 뒤 결과를 보내고 journal 완료는 계속 실행한다`, async () => {
  const f = fixture(), writer = await f.transition.initialize(), res = response();
  const result = { success: true, ...(kind === 'membership' ? { uid: 'synthetic', membership: { status: 'none' } } : { role: 'owner' }) };
  const request = withAuthenticationResult(req, res, kind, async output => {
    prepareAuthenticationResult(result, () => output.set('Set-Cookie', 'synthetic-only'));
    await f.transition.prepareAndExecuteWithReceipt(writer, 'b'.repeat(32),
      [{ key: 'synthetic', exists: true, token: '0', value: { checked: true } }], null,
      { details: { kind: kind === 'admin' ? 'session' : kind, action: kind === 'admin' ? 'set' : 'complete' } });
    output.json(result);
  });
  try {
    assert.deepEqual((await res.first).result, result);
    await f.reached.promise;
    assert.equal(f.committed(), true); assert.equal(res.writableEnded, false);
    assert.equal(f.state().operations['b'.repeat(32)].status, 'executing');
    assert.equal(res.headers['Set-Cookie'], 'synthetic-only');
  } finally { f.gate.resolve(); await request; }
  assert.equal(res.frames.at(-1).type, 'recorded'); assert.equal(res.frames.at(-1).success, true);
  assert.equal(f.state().operations['b'.repeat(32)].status, 'completed');
});
for (const options of [{ commitError: true }, { invalidReceipt: true }]) test(`미확정·변조 업무 영수증에는 인증 성공을 먼저 보내지 않는다: ${JSON.stringify(options)}`, async () => {
  const f = fixture(options), writer = await f.transition.initialize(), res = response();
  await assert.rejects(withAuthenticationResult(req, res, 'membership', async () => {
    prepareAuthenticationResult({ success: true });
    await f.transition.prepareAndExecuteWithReceipt(writer, 'c'.repeat(32),
      [{ key: 'synthetic', exists: true, token: '0', value: 1 }], null,
      { details: { kind: 'membership', action: 'complete' } });
  }));
  assert.equal(res.frames.length, 0); assert.equal(f.state().operations['c'.repeat(32)].status, 'executing');
});
test('기록 실패는 별도 종료 신호로 전달하고 executing·영수증 복구 경계를 보존한다', async () => {
  const f = fixture({ recordError: true }), writer = await f.transition.initialize(), res = response();
  const request = withAuthenticationResult(req, res, 'membership', async () => {
    prepareAuthenticationResult({ success: true, uid: 'synthetic' });
    await f.transition.prepareAndExecuteWithReceipt(writer, 'd'.repeat(32),
      [{ key: 'synthetic', exists: true, token: '0', value: 1 }], null,
      { details: { kind: 'membership', action: 'complete' } });
  });
  await res.first; f.gate.resolve(); await request;
  assert.equal(res.frames[0].result.success, true); assert.equal(res.frames[1].success, false);
  assert.equal(f.state().operations['d'.repeat(32)].status, 'executing');
});
test('관리자 결과는 세션 저장 뒤 먼저 전송하고 부모 기록 정리를 기다리지 않는다', async () => {
  const gate = deferred(), store = createMemoryStore(), res = response();
  store.withRequest = async (_req, action) => { try { return await action(); } finally { await gate.promise; } };
  const auth = { verifyIdToken: async () => ({ uid: 'synthetic', auth_time: 100 }),
    getUser: async () => ({ uid: 'synthetic', customClaims: { role: 'owner' } }), createSessionCookie: async () => 'synthetic-cookie' };
  const handler = createAdminPageHandler({ auth, store, template: async () => '<html></html>' });
  const request = handler({ ...req, url: '/admin/session', protocol: 'https', headers: { host: 'synthetic.invalid', origin: 'https://synthetic.invalid',
    authorization: 'Bearer synthetic', 'content-type': 'application/json' } }, res);
  try { assert.equal((await res.first).result.role, 'owner'); assert.equal(res.writableEnded, false); }
  finally { gate.resolve(); await request; }
  assert.equal(res.frames.at(-1).success, true);
});
test('비관리자·철회·비활성 계정의 거부 응답은 스트림 성공으로 바뀌지 않는다', async () => {
  for (const user of [{ customClaims: {} }, { disabled: true, customClaims: { role: 'owner' } },
    { tokensValidAfterTime: new Date(200000).toISOString(), customClaims: { role: 'owner' } }]) {
    const res = response(), handler = createAdminPageHandler({ store: createMemoryStore(), template: async () => '',
      auth: { verifyIdToken: async () => ({ uid: 'synthetic', auth_time: 100 }), getUser: async () => user } });
    await handler({ ...req, url: '/admin/session', protocol: 'https', headers: { host: 'synthetic.invalid', origin: 'https://synthetic.invalid',
      authorization: 'Bearer synthetic', 'content-type': 'application/json' } }, res);
    assert.equal(res.frames.length, 0); assert([401, 403].includes(res.statusCode)); assert.equal(res.body.success, false);
  }
});
for (const provider of ['youtube', 'discord']) for (const wrongUser of [false, true]) test(`로컬 ${provider}: 첫 결과 UID·증명 검사와 비동기 로컬 기록 분리 (${wrongUser ? '다른 UID 거부' : '일치'})`, async () => {
  const capital = provider === 'youtube' ? 'Youtube' : 'Discord', localRecord = deferred();
  const membership = { status: 'none', type: provider === 'youtube' ? 'csv' : 'discord', verificationVersion: 2,
    verificationProvider: provider, ...(provider === 'youtube' ? { userChannelId: 'UC' + 'a'.repeat(22) } : { discordId: '123456789012345678' }) };
  const result = { success: true, uid: wrongUser ? 'other' : 'synthetic', sourceMembership: membership, membership };
  const body = [{ v: 1, type: 'result', result }, { v: 1, type: 'recorded', success: true, result }]
    .map(value => JSON.stringify(value) + '\n').join('');
  const transport = require(`../services/${provider}MembershipTransport`)[`forward${capital}Membership`];
  let stored = false;
  const common = { env: {}, isLocal: () => true, verifyAppCheck: async () => true, verifyRegisteredUser: async () => 'synthetic', setCors() {},
    forward: (operation, data, headers, _fetch, options) => transport(operation, data, headers,
      async () => new Response(body, { headers: { 'Content-Type': 'application/x-ndjson' } }), options),
    db: { collection: () => ({ doc: () => ({ set: async () => { await localRecord.promise; stored = true; } }) }) } };
  const service = require(`../services/${provider}Membership`), handlers = service[`create${capital}MembershipHandlers`](common), res = response();
  const request = handlers[`verify${capital}Membership`]({ ...req, headers: { authorization: 'Bearer synthetic', 'x-firebase-appcheck': 'synthetic' } }, res);
  try {
    if (wrongUser) { await request; assert.equal(res.frames.length, 0); assert.equal(res.statusCode, 503); }
    else { assert.equal((await res.first).result.sourceMembership.status, 'none'); assert.equal(stored, false); }
  } finally { localRecord.resolve(); await request; }
  assert.equal(stored, !wrongUser);
  if (!wrongUser) assert.equal(res.frames.at(-1).success, true);
});

test('Hosting 관리자 중계는 첫 결과를 JSON과 HttpOnly 쿠키로 끝내고 backend 기록 요청은 끝까지 회수한다', async () => {
  const { createAdminProxy } = require('../services/adminTransport');
  const first = deferred(); let stream, finished = false;
  const body = new ReadableStream({ start(controller) { stream = controller; } });
  const handler = createAdminProxy({ authenticationResultOnly: true, fetchImpl: async () => new Response(body, { headers: {
    'X-YGO-Admin-Backend': '1', 'Content-Type': 'application/x-ndjson',
    'Set-Cookie': '__session=synthetic; Path=/admin; HttpOnly; SameSite=Strict; Secure' } }) });
  const res = response(), json = res.json;
  res.json = function (value) { this.headersSent = this.writableEnded = true; first.resolve(value); return json.call(this, value); };
  const request = handler({ method: 'POST', url: '/admin/session', protocol: 'https', headers: { host: 'ygo-synapse.web.app',
    origin: 'https://ygo-synapse.web.app', 'content-type': 'application/json', authorization: 'Bearer synthetic' },
    body: { authenticationResultStream: true } }, res).then(() => { finished = true; });
  stream.enqueue(new TextEncoder().encode(JSON.stringify({ v: 1, type: 'result', result: { success: true, role: 'owner' } }) + '\n'));
  assert.equal((await first.promise).success, true); assert.equal(finished, false);
  assert.match(res.headers['Set-Cookie'], /HttpOnly/); assert.match(res.headers['Content-Type'], /application\/json/);
  stream.enqueue(new TextEncoder().encode(JSON.stringify({ v: 1, type: 'recorded', success: true, result: { success: true, role: 'owner' } }) + '\n'));
  stream.close(); await request; assert.equal(finished, true);
});
