const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

function credentialFixture(credentials, { explicit = true } = {}) {
  let reads = 0;
  const filename = '/fixture/adc.json';
  const env = explicit ? { GOOGLE_APPLICATION_CREDENTIALS: filename } : {};
  const context = {
    env, homeDirectory: '/fixture', platform: 'darwin',
    readFile(file) { reads++; assert.equal(file, explicit ? filename : '/fixture/.config/gcloud/application_default_credentials.json');
      return typeof credentials === 'string' ? credentials : JSON.stringify(credentials); },
    exists: () => true,
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'cloud_credentials.js'), 'utf8'), {
    module, exports: module.exports, process: { env, platform: 'darwin' },
    require(name) {
      if (name === 'node:fs') return { readFileSync: context.readFile, existsSync: context.exists };
      if (name === 'node:os') return { homedir: () => '/fixture' };
      if (name === 'node:path') return path;
      throw new Error('외부 접근 금지');
    },
  });
  return { ...module.exports, context, get reads() { return reads; } };
}

for (const type of ['authorized_user', 'external_account', 'impersonated_service_account']) {
  test(`장기 비밀키가 없는 ${type} 인증 설정을 허용한다`, () => {
    const f = credentialFixture({ type });
    assert.doesNotThrow(() => f.assertKeylessApplicationCredentials(f.context));
  });
}

test('환경변수와 기본 ADC 경로의 서비스 계정 키를 모두 거부하며 값을 출력하지 않는다', () => {
  for (const explicit of [true, false]) {
    const f = credentialFixture({ type: 'service_account', private_key: 'fixture-private-value' }, { explicit });
    assert.throws(() => f.assertKeylessApplicationCredentials(f.context), error =>
      error.message.includes('서비스 계정 비밀키') && !error.message.includes('fixture-private-value'));
  }
});

test('다른 인증 형식 안에 들어 있는 서비스 계정 비밀키도 거부한다', () => {
  const f = credentialFixture({ type: 'impersonated_service_account',
    source_credentials: { type: 'service_account', private_key: 'fixture' } });
  assert.throws(() => f.assertKeylessApplicationCredentials(f.context), /서비스 계정 비밀키/);
});

test('잘못된 설정을 기본 인증으로 대체하지 않으며 오류에 원문을 남기지 않는다', () => {
  const f = credentialFixture('fixture-sensitive-invalid-json');
  assert.throws(() => f.assertKeylessApplicationCredentials(f.context), error =>
    error.message.includes('설정을 읽지 못했습니다') && !error.message.includes('fixture-sensitive'));
});

test('로컬 키 파일을 탐색하지 않고 SDK 기본 인증으로 지정 프로젝트를 초기화한다', () => {
  const f = credentialFixture({ type: 'authorized_user' });
  const app = { options: null }, admin = {
    apps: [], credential: { applicationDefault: () => ({ mode: 'adc' }) },
    initializeApp(options) { app.options = options; this.apps.push(app); }, app: () => app,
  };
  f.initializeDataToolFirebaseApp(admin, { projectId: 'fixture-project', storageBucket: 'fixture-bucket' });
  assert.equal(app.options.projectId, 'fixture-project');
  assert.equal(app.options.storageBucket, 'fixture-bucket');
  assert.equal(app.options.credential.mode, 'adc');
  assert.equal(f.reads, 1);
});

test('이미 만들어진 앱의 비밀키 인증·다른 프로젝트를 재사용하지 않는다', () => {
  const f = credentialFixture({ type: 'authorized_user' });
  for (const options of [{ projectId: 'fixture', credential: { privateKey: 'fixture-key' } },
    { projectId: 'other', credential: {} }]) {
    assert.throws(() => f.initializeDataToolFirebaseApp({ apps: [{}], app: () => ({ options }) },
      { projectId: 'fixture' }), /인증 또는 프로젝트/);
  }
});

test('비밀키 설정은 SDK 초기화나 데이터 접근 전에 거부한다', () => {
  const f = credentialFixture({ type: 'service_account', private_key: 'fixture' });
  assert.throws(() => f.initializeDataToolFirebaseApp({ apps: [],
    initializeApp() { assert.fail('초기화 금지'); } }, { projectId: 'fixture' }), /비밀키/);
});

test('설치된 SDK가 WIF ADC로 Firebase 앱·Storage·Firestore를 구성한다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ygo-wif-sdk-'));
  try {
    const filename = path.join(dir, 'adc.json');
    fs.writeFileSync(filename, JSON.stringify({
      type: 'external_account',
      audience: '//iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/fixture/providers/fixture',
      subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
      token_url: 'https://sts.googleapis.com/v1/token',
      credential_source: { file: path.join(dir, 'subject.jwt') },
    }), { mode: 0o600 });
    const script = `
      const admin = require('./functions/node_modules/firebase-admin');
      const { GoogleAuth } = require('./functions/node_modules/google-auth-library');
      const { initializeDataToolFirebaseApp } = require('./scripts/cloud_credentials');
      global.fetch = () => { throw new Error('실제 인증 요청 금지'); };
      (async () => {
        const client = await new GoogleAuth({ projectId: 'fixture', scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).getClient();
        const app = initializeDataToolFirebaseApp(admin, { projectId: 'fixture', storageBucket: 'fixture-bucket' });
        const bucket = admin.storage().bucket('fixture-bucket');
        const db = admin.firestore();
        if (client.constructor.name !== 'IdentityPoolClient' || bucket.name !== 'fixture-bucket' || db.projectId !== 'fixture') throw new Error('SDK 구성 실패');
        await app.delete();
        console.log('SDK 구성 확인');
      })().catch(() => { process.exitCode = 1; });
    `;
    const output = execFileSync(process.execPath, ['-e', script], {
      cwd: path.resolve(__dirname, '..'), env: { ...process.env, GOOGLE_APPLICATION_CREDENTIALS: filename },
      encoding: 'utf8', timeout: 10000,
    });
    assert.match(output, /SDK 구성 확인/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
