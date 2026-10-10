const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { safeErrorSummary } = require('../utils/safeError');

const SECRET = 'dummy-sensitive-value-for-regression';
function sensitiveError(status = 401) {
  return Object.assign(new Error(SECRET), {
    name: SECRET, code: SECRET, isAxiosError: true,
    config: { url: `https://example.invalid/?token=${SECRET}`,
      headers: { Authorization: `Bearer ${SECRET}` }, data: `client_secret=${SECRET}` },
    response: { status, data: { access_token: SECRET, message: SECRET } },
  });
}

function load(relative, mocks) {
  const logs = [];
  const module = { exports: {} };
  const filename = path.join(__dirname, '..', relative);
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, URLSearchParams, Buffer, process: { env: {} },
    console: Object.fromEntries(['log', 'warn', 'error'].map(level =>
      [level, (...args) => logs.push([level, ...args])])),
    require(name) {
      if (name === '../services/publicReadTransport' || name === './publicReadTransport') return { isLocal: () => false, withPublicReadRequest: handler => handler };
      if (!Object.hasOwn(mocks, name)) throw new Error(`격리되지 않은 의존성: ${name}`);
      return mocks[name];
    },
  }, { filename });
  return { exports: module.exports, logs };
}

function response() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    set() {},
  };
}

function assertPrivate(logs, body) {
  const text = JSON.stringify({ logs, body });
  assert.ok(!text.includes(SECRET), '로그 또는 응답에 더미 비밀값이 남았습니다.');
  assert.ok(logs.length > 0, '실패 경로가 실제로 실행되어야 합니다.');
}

test('오류 요약은 비밀값이 포함된 메시지·헤더·본문·URL·코드를 제외한다', () => {
  assert.deepEqual(safeErrorSummary(sensitiveError()), { type: 'http_request_error', status: 401 });
  assert.deepEqual(safeErrorSummary(new Error(SECRET)), { type: 'internal_error' });
  for (const status of [SECRET, '401', 99, 600, NaN, undefined]) {
    const error = sensitiveError();
    error.response.status = status;
    assert.deepEqual(safeErrorSummary(error), { type: 'http_request_error' });
  }
  assert.deepEqual(safeErrorSummary(null), { type: 'internal_error' });
});

test('Discord OAuth 교환 실패와 사용자 조회 실패는 인증정보를 로그에 남기지 않는다', async () => {
  for (const failAt of ['token', 'user']) {
    const error = sensitiveError();
    const f = load('integrations/discord.js', {
      axios: {
        post: async () => { if (failAt === 'token') throw error; return { data: { access_token: SECRET } }; },
        get: async () => { throw error; },
      },
      '../utils/safeError': { safeErrorSummary },
    });
    await assert.rejects(f.exports.getDiscordUserWithCode(SECRET, 'https://example.invalid', 'client', SECRET), e => e === error);
    assertPrivate(f.logs);
  }
});

test('Discord 역할 조회 오류를 안전하게 기록하고 404의 비회원 처리를 보존한다', async () => {
  for (const status of [404, 403]) {
    const error = sensitiveError(status);
    const f = load('integrations/discord.js', {
      axios: { get: async () => { throw error; } },
      '../utils/safeError': { safeErrorSummary },
    });
    if (status === 404) {
      const result = await f.exports.checkGuildMemberRole(SECRET, 'guild', 'user', 'role');
      assert.equal(result.isMember, false);
      assert.equal(result.hasRole, false);
    } else {
      await assert.rejects(f.exports.checkGuildMemberRole(SECRET, 'guild', 'user', 'role'), e => e === error);
    }
    assertPrivate(f.logs);
  }
});

test('Discord 성공 응답은 액세스 토큰 대신 사용자 정보와 역할 판정만 반환한다', async () => {
  const f = load('integrations/discord.js', {
    axios: {
      post: async () => ({ data: { access_token: SECRET } }),
      get: async url => ({ data: url.endsWith('/@me')
        ? { id: 'user', username: 'tester', access_token: SECRET }
        : { roles: ['role'], user: { id: 'user' } } }),
    },
    '../utils/safeError': { safeErrorSummary },
  });
  const user = await f.exports.getDiscordUserWithCode(SECRET, 'https://example.invalid', 'client', SECRET);
  const role = await f.exports.checkGuildMemberRole(SECRET, 'guild', 'user', 'role');
  assert.equal(user.id, 'user');
  assert.equal(role.hasRole, true);
  assert.ok(!JSON.stringify({ user, role, logs: f.logs }).includes(SECRET));
});

function routeFixture() {
  const error = sensitiveError();
  const secret = { value: () => SECRET };
  return load('routes/integration.js', {
    'firebase-functions/v2/https': { onRequest: (_options, handler) => handler },
    '../config/firebase': {
      db: { collection: () => ({ doc: () => ({ get: async () => { throw error; } }),
        get: async () => { throw error; } }) },
      admin: { auth: () => ({ getUser: async () => ({ customClaims: { role: 'admin' } }) }) },
      DISCORD_BOT_TOKEN: secret, DISCORD_CLIENT_SECRET: secret,
    },
    '../services/adminActionTransport': { forwardAdminRequest: async () => false },
    'node:crypto': require('node:crypto'),
    '../services/membershipCsvService': require('../services/membershipCsvService'),
    '../utils/auth': { setCors() {}, verifyAppCheck: async () => true, verifyAdmin: async () => ({uid:'uid',role:'admin'}), verifyRegisteredUser: async () => 'uid' },
    '../utils/safeError': { safeErrorSummary },
    '../integrations/googleSheets': { sheetsIsValidSpreadsheetId: require('../integrations/googleSheets').sheetsIsValidSpreadsheetId },
    '../services/migrationService': { migrationFetchPublicMyCardData: async () => { throw error; } },
    '../integrations/discord': { getDiscordUserWithCode: async () => { throw error; } },
  });
}

for (const [route, body, query, status] of [
  ['uploadMembershipCsv', { members: [{ channelId: 'UC'+'a'.repeat(22), memberName:'합성 회원', levelName:'합성 등급' }] }, {}, 503],
  ['checkSheet', {}, { targetId: 'a'.repeat(30) }, 503],
]) {
  test(`${route} 실패 로그와 클라이언트 응답에 인증정보를 포함하지 않는다`, async () => {
    const f = routeFixture();
    const res = response();
    await f.exports[route]({ method: route === 'checkSheet' ? 'GET' : 'POST', body, query }, res);
    assert.equal(res.statusCode, status);
    assertPrivate(f.logs, res.body);
  });
}

test('구버전 CSV API는410으로 거부하고 요청의 인증정보를 로그·응답에 남기지 않는다', async () => {
  const f = routeFixture();
  const res = response();
  await f.exports.checkMembershipCsv({ method: 'POST', body: { userChannelId: SECRET, accessToken: SECRET },
    query: { userChannelId: SECRET }, headers: { authorization: `Bearer ${SECRET}` } }, res);
  assert.equal(res.statusCode, 410);
  assert.equal(res.body.code, 'YOUTUBE_PROOF_REQUIRED');
  assert.equal(res.body.success, false);
  assert.equal(f.logs.length, 0);
  assert.ok(!JSON.stringify({ logs: f.logs, body: res.body }).includes(SECRET));
});

test('구버전 Discord API는410으로 거부하며 비밀정보를 기록하지 않는다', async () => {
  const f = routeFixture(), res = response();
  await f.exports.checkMembershipDiscord({ method: 'POST', body: { code: SECRET, redirectUri: SECRET } }, res);
  assert.equal(res.statusCode, 410);
  assert.equal(res.body.code, 'DISCORD_PROOF_REQUIRED');
  assert.equal(f.logs.length, 0);
  assert.ok(!JSON.stringify(res.body).includes(SECRET));
});

for (const [method, general] of [['verifyUser', false], ['verifyAppCheck', false], ['verifyAppCheck', true]]) {
  test(`${method} 인증 오류는 토큰과 원본 오류 메시지를 기록하지 않는다 (general=${general})`, async () => {
    const error = sensitiveError();
    const f = load('utils/auth.js', {
      '../config/firebase': { admin: {
        auth: () => ({ verifyIdToken: async () => { throw error; } }),
        appCheck: () => { if (general) throw error; return { verifyToken: async () => { throw error; } }; },
      } },
      './safeError': { safeErrorSummary },
    });
    const res = response();
    const result = await f.exports[method]({ headers: { authorization: `Bearer ${SECRET}`, 'x-firebase-appcheck': SECRET } }, res);
    assert.ok(!result);
    assert.equal(res.statusCode, 503);
    assertPrivate(f.logs, res.body);
  });
}
