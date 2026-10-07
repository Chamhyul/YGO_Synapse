const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const path = require('node:path');

function load(file, mocks) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
    module, exports: module.exports, console: { error() {} }, process: { env: {} },
    require(name) { assert.ok(name in mocks, name); return mocks[name]; },
  });
  return module.exports;
}
function fixture({ existing, inventory = false, auth = true, failure = false } = {}) {
  let data = existing, reads = 0, writes = 0;
  const ref = { async get() { reads++; if (failure) throw Error('private'); return { exists: !!data, data: () => data }; } };
  const db = { collection: () => ({ doc: () => ref }),
    async runTransaction(fn) { return fn({ get: () => ref.get(), create(_, value) { assert.equal(data, undefined); writes++; data = value; } }); } };
  const config = { db, FieldValue: { serverTimestamp: () => 'server-time' },
    getBucket: () => ({ file: () => ({ exists: async () => [inventory] }) }) };
  const service = load('services/registrationService.js', { '../config/firebase': config });
  const routes = load('routes/registration.js', {
    'firebase-functions/v2/https': { onRequest: (_, fn) => fn }, '../config/firebase': config,
    '../services/registrationService': service, '../utils/safeError': { safeErrorSummary: () => ({ type: 'internal_error' }) },
    '../utils/auth': { setCors() {}, verifyAppCheck: async () => true,
      verifyUser: async (_, res) => { if (auth) return 'fixture-user'; res.status(401).json({ success: false }); return null; } },
  });
  const res = () => ({ code: 200, headers: {}, set(k, v) { this.headers[k] = v; return this; },
    status(n) { this.code = n; return this; }, json(body) { this.body = body; return this; }, send() { return this; } });
  return { routes, res, service, stats: () => ({ data, reads, writes }) };
}
async function status(f) { const r = f.res(); await f.routes.getRegistrationStatus({ method: 'GET', headers: {} }, r); return r; }
async function complete(f, body) { const r = f.res(); await f.routes.completeRegistration({ method: 'POST', body }, r); return r; }

test('신규 가입 여부 조회는 서비스 문서·인벤토리를 생성하지 않는다', async () => {
  const f = fixture(), r = await status(f);
  assert.equal(r.body.registered, false); assert.equal(f.stats().writes, 0);
  assert.equal(r.headers['Cache-Control'], 'no-store');
});
test('기존 문서 또는 구형 인벤토리가 있으면 재동의 없이 기존 회원이다', async () => {
  for (const options of [{ existing: { Nickname: 'legacy' } }, { inventory: true }]) {
    const f = fixture(options); assert.equal((await status(f)).body.registered, true);
    assert.equal(f.stats().writes, 0);
  }
});
test('동의 두 개와 최신 문서 버전이 없으면 계정을 생성하지 않는다', async () => {
  const f = fixture(), versions = (await status(f)).body.consentVersions;
  for (const agreements of [{ terms: true }, { privacy: true }, { terms: 'true', privacy: true }]) {
    assert.equal((await complete(f, { agreements, consentVersions: versions })).code, 400);
  }
  assert.equal((await complete(f, { agreements: { terms: true, privacy: true }, consentVersions: { terms: 'old', privacy: 'old' } })).code, 409);
  assert.equal(f.stats().writes, 0);
});
test('가입 완료는 서버 시각·문서 버전을 저장하며 반복 요청은 기존 데이터를 보존한다', async () => {
  const f = fixture(), versions = (await status(f)).body.consentVersions;
  const body = { agreements: { terms: true, privacy: true }, consentVersions: versions, uid: 'other', createdAt: 'client-time' };
  assert.equal((await complete(f, body)).body.registered, true);
  assert.equal((await complete(f, body)).body.registered, true);
  assert.equal(f.stats().writes, 1); assert.equal(f.stats().data.createdAt, 'server-time');
  assert.equal(f.stats().data.registration.consent.acceptedAt, 'server-time');
  assert.equal(f.stats().data.registration.consent.terms, versions.terms);
  assert.equal(f.stats().data.uid, undefined);
});
test('기존 회원 가입 완료 재요청은 과거 동의 이력을 꾸며내지 않는다', async () => {
  const existing = { createdAt: 123, Nickname: 'preserve', settings: { theme: 'dark' } };
  const f = fixture({ existing }), versions = (await status(f)).body.consentVersions;
  await complete(f, { agreements: { terms: true, privacy: true }, consentVersions: versions });
  assert.equal(f.stats().data, existing); assert.equal(f.stats().writes, 0);
});
test('조회 장애·인증 누락·잘못된 메서드는 생성 없이 실패한다', async () => {
  for (const [options, code] of [[{ failure: true }, 503], [{ auth: false }, 401]]) {
    const f = fixture(options), r = await status(f);
    assert.equal(r.code, code); assert.equal(f.stats().writes, 0);
    assert.doesNotMatch(JSON.stringify(r.body), /private/);
  }
  const f = fixture(), r = f.res(); await f.routes.completeRegistration({ method: 'GET' }, r);
  assert.equal(r.code, 405);
});
test('동의 버전은 현재 공개 문서의 해시와 일치한다', async () => {
  const versions = (await status(fixture())).body.consentVersions;
  for (const name of ['terms', 'privacy']) {
    assert.equal(versions[name], crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, '../../public', name + '.html'))).digest('hex'));
  }
});
test('가입 전 보호 API 검증은 403, 장애는 503이며 기존 회원은 허용한다', async () => {
  for (const registered of [false, true, 'failure']) {
    const helpers = load('utils/auth.js', {
      '../config/firebase': { admin: { auth: () => ({ verifyIdToken: async () => ({ uid: 'test-user' }) }) } },
      './safeError': { safeErrorSummary: () => ({ type: 'internal_error' }) },
      '../services/registrationService': { isRegisteredUser: async () => { if (registered === 'failure') throw Error('secret'); return registered; } },
    });
    const r = fixture().res();
    const result = await helpers.verifyRegisteredUser({ headers: { authorization: 'Bearer dummy' } }, r);
    assert.equal(result, registered === true ? 'test-user' : null);
    assert.equal(r.code, registered === true ? 200 : registered === false ? 403 : 503);
  }
});

test('사용자 데이터·관리·이식·개인 멤버십 라우트는 가입 완료 검증을 사용한다', () => {
  for (const file of ['user', 'card', 'migration']) {
    const source = fs.readFileSync(path.join(__dirname, '../routes', file + '.js'), 'utf8');
    assert.match(source, /await verifyRegisteredUser\(req, res\)/);
    assert.doesNotMatch(source, /await verifyUser\(req, res\)/);
  }
  const source = fs.readFileSync(path.join(__dirname, '../routes/integration.js'), 'utf8');
  for (const name of ['checkMembershipDiscord', 'checkMembershipCsv']) {
    const start = source.indexOf('exports.' + name);
    const end = source.indexOf('\nexports.', start + 1);
    assert.match(source.slice(start, end < 0 ? undefined : end), /await verifyRegisteredUser\(req, res\)/);
  }
});
