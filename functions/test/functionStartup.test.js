'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fixture = require('./functionExports.fixture.json');

const authenticationTargets = {
  adminPages: 'routes/admin/pages.js',
  adminBackend: 'routes/admin/pages.js',
  startYoutubeMembershipVerification: 'routes/youtubeMembership.js',
  verifyYoutubeMembership: 'routes/youtubeMembership.js',
  startDiscordMembershipVerification: 'routes/discordMembership.js',
  verifyDiscordMembership: 'routes/discordMembership.js',
  getUserData: 'routes/user.js',
};

// 인증 없는 실제 HTTP 거부와 SDK endpoint 메타정보를 전체 로딩 경로와 대조한다.
function authenticationProbe(target, extraEnv = {}) {
  const script = `
    const functions = require('./index'), target = process.env.FUNCTION_TARGET;
    const ownRoute = ${JSON.stringify(authenticationTargets)}[target];
    const routes = ['routes/cardCatalog.js', 'routes/inventory.js', 'routes/deck.js',
      'schedules/autoCrawler.js', 'tasks/membershipClaims.js',
      ...Object.values(${JSON.stringify(authenticationTargets)})].filter(route => route !== ownRoute);
    const unrelated = Object.keys(require.cache).filter(p => routes.some(route => p.endsWith('/' + route)));
    const endpoint = functions[target]?.__endpoint;
    (async () => {
      const app = require('express')(); app.use(require('express').json()); app.use(functions[target]);
      const server = app.listen(0, '127.0.0.1');
      await new Promise(resolve => server.on('listening', resolve));
      try {
        const url = 'http://127.0.0.1:' + server.address().port;
        const options = await fetch(url, { method: 'OPTIONS' });
        const denied = await fetch(url, { method: 'POST', headers: {'content-type':'application/json'}, body:'{}' });
        console.log(JSON.stringify({names:Object.keys(functions).sort(), endpoint, unrelated,
          options:options.status, denied:denied.status, body:await denied.text()}));
      } finally { server.closeAllConnections(); server.close(); }
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const output = execFileSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '..'), timeout: 20000, encoding: 'utf8',
    env: { PATH: process.env.PATH, NODE_ENV: 'test', GCLOUD_PROJECT: 'demo-startup',
      FUNCTION_TARGET: target, ...extraEnv },
  });
  return JSON.parse(output.trim().split('\n').at(-1));
}

for (const target of Object.keys(authenticationTargets)) {
  test(`${target} 관리형 기동은 자체 라우트만 로드하고 인증 거부·배포 옵션을 유지한다`, () => {
    const full = authenticationProbe(target);
    const scoped = authenticationProbe(target, { K_SERVICE: 'synthetic-authentication', K_REVISION: 'synthetic' });
    assert.deepEqual(full.names, fixture);
    assert.deepEqual(scoped.names, [target]);
    assert.deepEqual(scoped.unrelated, []);
    assert.deepEqual(scoped.endpoint, full.endpoint);
    assert.equal(scoped.options, full.options);
    assert(scoped.denied >= 400);
    assert.equal(scoped.denied, full.denied);
    assert.equal(scoped.body, full.body);
  });
}

test('인증 함수의 에뮬레이터·불완전 관리형 환경은 전체 export를 유지한다', () => {
  for (const extra of [{ K_SERVICE: 'synthetic' }, { K_REVISION: 'synthetic' },
    { K_SERVICE: 'synthetic', K_REVISION: 'synthetic', FUNCTIONS_EMULATOR: 'true' },
    { K_SERVICE: 'synthetic', K_REVISION: 'synthetic', FIREBASE_EMULATOR_HUB: '127.0.0.1:4400' }]) {
    assert.deepEqual(authenticationProbe('startDiscordMembershipVerification', extra).names, fixture);
  }
});

test('선택 대상의 프로토타입 속성은 모듈 경로로 사용하지 않는다', () => {
  const output = execFileSync(process.execPath, ['-e',
    "console.log(JSON.stringify(Object.keys(require('./index')).sort()))"], {
    cwd: path.resolve(__dirname, '..'), timeout: 20000, encoding: 'utf8',
    env: { PATH: process.env.PATH, NODE_ENV: 'test', GCLOUD_PROJECT: 'demo-startup',
      FUNCTION_TARGET: 'constructor', K_SERVICE: 'synthetic', K_REVISION: 'synthetic' },
  });
  assert.deepEqual(JSON.parse(output.trim().split('\n').at(-1)), fixture);
});

// 실제 SDK와 별도 프로세스를 사용한다. 자격증명·운영 설정을 전달하지 않으며
// OPTIONS/미인증 요청만 로컬 소켓으로 실행한다.
function probe(env) {
  const script = `
    const http = require('node:http');
    const functions = require('./index');
    const target = process.env.FUNCTION_TARGET || 'addCards';
    const fn = functions[target];
    (async () => {
      const app = require('express')();
      app.use(require('express').json()); app.use(fn);
      const server = http.createServer(app);
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      try {
        const url = 'http://127.0.0.1:' + server.address().port;
        const options = await fetch(url, { method: 'OPTIONS' });
        const denied = await fetch(url, { method: 'POST', headers: {'content-type':'application/json'}, body:'{}' });
        console.log(JSON.stringify({ names: Object.keys(functions).sort(),
          endpoint: fn.__endpoint, options: options.status, denied: denied.status,
          code: (await denied.json()).code,
          unrelated: Object.keys(require.cache).filter(p => ['routes/cardCatalog.js', 'routes/deck.js', 'routes/admin/pages.js'].some(route => p.endsWith('/' + route))) }));
      } finally { server.closeAllConnections(); server.close(); }
    })().catch(e => { console.error(e); process.exitCode = 1; });
  `;
  const cleanEnv = { PATH: process.env.PATH, NODE_ENV: 'test', GCLOUD_PROJECT: 'demo-startup', ...env };
  const output = execFileSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '..'), env: cleanEnv, timeout: 20000, encoding: 'utf8',
  });
  return JSON.parse(output.trim().split('\n').at(-1));
}

test('배포 탐색과 에뮬레이터는 전체 진입점을 유지한다', () => {
  for (const env of [{}, { FUNCTION_TARGET: 'addCards' },
    { K_SERVICE: 'addcards', K_REVISION: 'test', FUNCTION_TARGET: 'addCards', FUNCTIONS_EMULATOR: 'true' },
    { K_SERVICE: 'addcards', K_REVISION: 'test', FUNCTION_TARGET: 'addCards', FIREBASE_EMULATOR_HUB: '127.0.0.1:4400' }]) {
    assert.deepEqual(probe(env).names, fixture);
  }
});

for (const target of ['addCards', 'discardCards']) {
  test(`${target} 관리형 기동은 불필요한 라우트 없이 기존 HTTP·메타정보를 유지한다`, () => {
    const full = probe({ FUNCTION_TARGET: target });
    const scoped = probe({ K_SERVICE: target.toLowerCase(), K_REVISION: 'test', FUNCTION_TARGET: target });
    assert.deepEqual(scoped.names, [target]);
    assert.deepEqual(scoped.unrelated, []);
    assert.deepEqual(scoped.endpoint, full.endpoint);
    assert.equal(scoped.options, 204);
    assert.equal(scoped.denied, 401);
    assert.equal(scoped.code, 'AUTH_INVALID');
  });
}

test('claims worker 관리형 기동은 전용 모듈만 로드하고 배포·에뮬레이터 메타정보를 유지한다', () => {
  const script = `
    let selections = 0;
    if (process.env.K_SERVICE && !process.env.FUNCTIONS_EMULATOR) {
      const id = require.resolve('./services/membershipProviderRuntime');
      require.cache[id] = { id, filename: id, loaded: true, exports: {
        resolveMembershipProviderRuntime: () => {
          selections++;
          return { config: { mode: 'production' }, storage: { writerTransition: {
            route() { throw Error('startup must not read a route'); }
          } } };
        }
      } };
    }
    const functions = require('./index');
    const fn = functions.syncMembershipClaimsAfterProfile;
    console.log(JSON.stringify({ selections, names: Object.keys(functions).sort(), endpoint: fn.__endpoint,
      unrelated: Object.keys(require.cache).filter(p => ['routes/cardCatalog.js', 'routes/inventory.js',
        'routes/deck.js', 'routes/admin/pages.js', 'services/userInventoryWriterRepository.js']
        .some(name => p.endsWith('/' + name))) }));
  `;
  const run = env => JSON.parse(execFileSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '..'), timeout: 20000, encoding: 'utf8',
    env: { PATH: process.env.PATH, NODE_ENV: 'test', GCLOUD_PROJECT: 'demo-startup',
      FUNCTION_TARGET: 'syncMembershipClaimsAfterProfile', ...env },
  }).trim().split('\n').at(-1));
  const full = run({});
  const scoped = run({ K_SERVICE: 'synthetic-worker', K_REVISION: 'synthetic' });
  assert.deepEqual(full.names, fixture);
  assert.deepEqual(scoped.names, ['syncMembershipClaimsAfterProfile']);
  assert.deepEqual(scoped.unrelated, []);
  assert.equal(scoped.selections, 1);
  assert.equal(full.selections, 0);
  assert.deepEqual(scoped.endpoint, full.endpoint);
  assert.deepEqual(run({ K_SERVICE: 'synthetic-worker', K_REVISION: 'synthetic',
    FUNCTIONS_EMULATOR: 'true' }).names, fixture);
});
