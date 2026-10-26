'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { fixture } = require('./commonWriterFixture.cjs');
const resultProtocol = require('../services/authenticationResult');
const { createWriterJournalStore } = require('../services/user-storage/writerJournalStore');
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function response() {
  const first = gate(), frames = [], headers = {};
  return { first: first.promise, frames, headers, statusCode: 200,
    status(value) { this.statusCode = value; return this; }, set(key, value) { headers[key] = value; return this; },
    json(value) { this.body = value; return this; }, type() { return this; }, send(value) { this.body = value; return this; },
    write(value) { const frame = JSON.parse(value); frames.push(frame); first.resolve(frame); },
    end(value) { if (value) frames.push(JSON.parse(value)); this.writableEnded = true; } };
}
async function setup(backend) {
  const f = await fixture(); f.mock('functions/services/authenticationResult.js', resultProtocol);
  await f.binding.transition.initialize();
  await f.binding.repository.completeRegistration(f.uid, { terms: 'synthetic', privacy: 'synthetic' });
  if (backend === 'rtdb') {
    const w = await f.binding.transition.route(); await f.binding.transition.copy(w);
    await f.binding.transition.drain(w); await f.binding.transition.activate(w);
  }
  let block = false;
  const pause = gate(), reached = gate(), database = f.connection.targetDatabase, ref = database.ref.bind(database);
  database.ref = path => {
    const target = ref(path);
    return new Proxy(target, { get(object, property) {
      if (property === 'transaction' && /^profileWriterTransitions\/[^/]+$/.test(path)) return async (...args) => {
        if (block) { reached.resolve(); await pause.promise; }
        return target.transaction(...args);
      };
      const value = Reflect.get(object, property, object); return typeof value === 'function' ? value.bind(object) : value;
    } });
  };
  return { ...f, pause, reached, block() { block = true; },
    journal: async () => (await createWriterJournalStore({ database: { ref } }).read(f.config.runId)).value };
}
for (const backend of ['legacy', 'rtdb']) for (const provider of ['youtube', 'discord']) test(`${backend}/${provider}: 실제 native 저장 뒤 journal 지연 중에도 회원 판정 결과를 전달한다`, async () => {
  const f = await setup(backend), res = response(); let request;
  try {
    const runtime = { storage: { ...f.binding.claimsStorage, membershipCsv: { readMember: async () => ({ levelName: '합성 회원' }) } },
      config: { mode: 'production' }, deferClaims: true };
    f.mock('functions/services/membershipProviderRuntime.js', {
      ...require('../services/membershipProviderRuntime'), resolveMembershipProviderRuntime: () => runtime });
    const service = f.load(`functions/services/${provider}Membership.js`);
    const common = { auth: f.binding.auth, storage: runtime.storage, env: f.env, setCors() {},
      verifyAppCheck: async () => true, verifyRegisteredUser: async () => f.uid,
      syncClaims: async () => ({ status: 'synced', version: 'synthetic' }) };
    const handlers = provider === 'youtube' ? service.createYoutubeMembershipHandlers({ ...common,
      fetchImpl: async () => ({ ok: true, json: async () => ({ items: [{ id: 'UC' + 'a'.repeat(22) }] }) }) })
      : service.createDiscordMembershipHandlers({ ...common, getClientSecret: () => 'synthetic-secret',
        getMembership: async () => ({ discordId: '123456789012345678', roles: ['1462257396020809800'] }) });
    const verificationId = 'a'.repeat(64), startedAt = Date.now();
    await f.binding.membership.start(f.uid, provider, { nonceHash: createHash('sha256').update(verificationId).digest('hex'),
      startedAt, expiresAt: startedAt + 300000, consumed: false, localOnly: false,
      ...(provider === 'discord' ? { redirectUri: 'https://ygo-synapse.web.app/' } : {}) });
    const write = res.write; res.write = function (value) { f.block(); return write.call(this, value); };
    request = handlers[provider === 'youtube' ? 'verifyYoutubeMembership' : 'verifyDiscordMembership']({ method: 'POST', headers: {},
      body: { authenticationResultStream: true, verificationId, accessToken: 'synthetic', code: 'synthetic' } }, res);
    const first = await res.first; await f.reached.promise;
    assert.equal(first.result.sourceMembership.status, 'active'); assert.equal(first.result.uid, f.uid);
    assert.equal(res.writableEnded, undefined);
    assert.equal((await f.binding.membership.read(f.uid)).membership.verificationProvider, provider);
    assert(Object.values((await f.journal()).operations).some(op => op.details?.kind === 'membership'
      && op.details.action === 'complete' && op.status === 'executing'));
    f.pause.resolve(); await request;
    assert.equal(res.frames.at(-1).success, true); assert.equal((await f.binding.transition.inspect()).unresolved, 0);
  } finally { f.pause.resolve(); await request; await f.close(); }
});
for (const backend of ['legacy', 'rtdb']) test(`${backend}/관리자: 결과 전달 시점에 세션이 존재하고 기록 완료 전에도 본문은 현재 역할을 검사한다`, async () => {
  const f = await setup(backend), res = response(); let request;
  try {
    const handler = f.load('functions/services/adminSessionRepository.js').createConfiguredAdminPageHandler({ auth: f.binding.auth,
      template: async () => '<html><body><section id="admin-login"></section><div id="admin-content" data-admin-title="합성">합성 본문</div></body></html>' },
    { env: f.env, writerBinding: f.binding });
    const headers = { host: 'synthetic.invalid', origin: 'https://synthetic.invalid', authorization: 'Bearer owner', 'content-type': 'application/json' };
    const write = res.write; res.write = function (value) { f.block(); return write.call(this, value); };
    request = handler({ method: 'POST', url: '/admin/session', protocol: 'https', headers, body: { authenticationResultStream: true } }, res);
    assert.equal((await res.first).result.role, 'owner'); await f.reached.promise;
    assert.match(res.headers['Set-Cookie'], /HttpOnly; SameSite=Strict; Secure/);
    const page = async () => { const output = response(); await handler({ method: 'GET', url: '/admin', protocol: 'https',
      headers: { ...headers, cookie: '__session=synthetic-session' } }, output); return output; };
    assert.match((await page()).body, /합성 본문/);
    await f.binding.auth.setCustomUserClaims(f.owner, {});
    assert.doesNotMatch((await page()).body, /id="admin-content"/);
    f.pause.resolve(); await request;
    assert.equal(res.frames.at(-1).success, true); assert.equal((await f.binding.transition.inspect()).unresolved, 0);
  } finally { f.pause.resolve(); await request; await f.close(); }
});

for (const backend of ['legacy', 'rtdb']) test(`${backend}/관리자 Hosting 중계: native 저장 후 기록이 멈춰 있어도 HttpOnly 쿠키 결과를 완결한다`, async () => {
  const f = await setup(backend), inner = response(), outer = response(), bodyReady = gate(); let request, relayRequest, stream;
  const body = new ReadableStream({ start(controller) { stream = controller; } });
  const write = inner.write, end = inner.end;
  inner.write = function(value) { f.block(); stream.enqueue(new TextEncoder().encode(value)); return write.call(this, value); };
  inner.end = function(value) { if (value) stream.enqueue(new TextEncoder().encode(value)); stream.close(); return end.call(this, value); };
  outer.json = function(value) { this.body = value; this.headersSent = this.writableEnded = true; bodyReady.resolve(value); return this; };
  try {
    const handler = f.load('functions/services/adminSessionRepository.js').createConfiguredAdminPageHandler({ auth: f.binding.auth,
      template: async () => '<html></html>' }, { env: f.env, writerBinding: f.binding });
    const headers = { host: 'synthetic.invalid', origin: 'https://synthetic.invalid', authorization: 'Bearer owner', 'content-type': 'application/json' };
    request = handler({ method: 'POST', url: '/admin/session', protocol: 'https', headers, body: { authenticationResultStream: true } }, inner);
    await inner.first; await f.reached.promise;
    const { createAdminProxy } = require('../services/adminTransport');
    const relay = createAdminProxy({ authenticationResultOnly: true, fetchImpl: async () => new Response(body, { headers: {
      'X-YGO-Admin-Backend': '1', 'Content-Type': 'application/x-ndjson', 'Set-Cookie': inner.headers['Set-Cookie'] } }) });
    relayRequest = relay({ method: 'POST', url: '/admin/session', protocol: 'https', headers, body: { authenticationResultStream: true } }, outer);
    assert.equal((await bodyReady.promise).role, 'owner'); assert.equal(outer.writableEnded, true); assert.equal(inner.writableEnded, undefined);
    assert.match(outer.headers['Set-Cookie'], /HttpOnly/);
    assert(Object.values((await f.journal()).operations).some(op => op.details?.kind === 'session' && op.details.action === 'set' && op.status === 'executing'));
    f.pause.resolve(); await request; await relayRequest; assert.equal(inner.frames.at(-1).success, true);
    assert.equal((await f.binding.transition.inspect()).unresolved, 0);
  } finally { f.pause.resolve(); await request; await relayRequest; await f.close(); }
});
