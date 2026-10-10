const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const vm = require('node:vm');
const yaml = require('../functions/node_modules/js-yaml');
const root = path.resolve(__dirname, '..');
const files = ['firebase-hosting-merge.yml', 'firebase-hosting-pull-request.yml', 'sync-card-illustrations.yml'];
const workflows = files.map(name => yaml.load(fs.readFileSync(path.join(root, '.github/workflows', name), 'utf8')));

test('각 자동 작업은 별도 단기 인증 설정을 사용하고 장기 키로 대체하지 않는다', () => {
  const providers = new Set(), accounts = new Set();
  for (const workflow of workflows) {
    const job = Object.values(workflow.jobs)[0];
    assert.equal(job.permissions['id-token'], 'write');
    assert.equal(job.permissions.contents, 'read');
    const auth = job.steps.find(step => step.uses === 'google-github-actions/auth@v3');
    assert.ok(auth);
    assert.equal(auth.with.project_id, 'ygo-synapse');
    assert.ok(!Object.hasOwn(auth.with, 'credentials_json'));
    providers.add(auth.with.workload_identity_provider);
    accounts.add(auth.with.service_account);
    assert.ok(!JSON.stringify(workflow).includes('FIREBASE_SERVICE_ACCOUNT_YGO_SYNAPSE'));
    assert.ok(job.steps.findIndex(step => step.uses?.startsWith('actions/checkout@')) < job.steps.indexOf(auth));
  }
  assert.equal(providers.size, 3);
  assert.equal(accounts.size, 3);
});

test('단기 인증 설정이 빠지면 클라우드 인증·배포 전에 실패한다', () => {
  for (const workflow of workflows) {
    const job = Object.values(workflow.jobs)[0];
    const preflight = job.steps.find(step => step.name === 'Check keyless authentication settings');
    assert.ok(job.steps.indexOf(preflight) < job.steps.findIndex(step => step.name === 'Authenticate to Google Cloud'));
    for (const env of [{}, { WIF_PROVIDER: 'fixture' }, { WIF_SERVICE_ACCOUNT: 'fixture' }]) {
      const result = spawnSync('/bin/bash', ['-c', preflight.run], { env, encoding: 'utf8' });
      assert.equal(result.status, 1);
    }
    assert.equal(spawnSync('/bin/bash', ['-c', preflight.run], {
      env: { WIF_PROVIDER: 'fixture', WIF_SERVICE_ACCOUNT: 'fixture' }, encoding: 'utf8',
    }).status, 0);
  }
});

test('외부 저장소 PR은 배포 작업을 실행하지 않으며 미리보기는 Hosting에 한정된다', () => {
  const job = Object.values(workflows[1].jobs)[0];
  assert.equal(job.if, '${{ github.event.pull_request.head.repo.full_name == github.repository }}');
  const deploy = job.steps.find(step => step.name === 'Deploy Hosting preview');
  assert.match(deploy.run, /hosting:channel:deploy/);
  assert.match(deploy.run, /--expires 7d/);
  assert.ok(!deploy.run.includes('--force'));
  for (const workflow of workflows) {
    for (const step of Object.values(workflow.jobs)[0].steps) {
      if (step.run) assert.equal(spawnSync('/bin/bash', ['-n'], { input: step.run }).status, 0);
    }
  }
});

async function publishPreview(result, comments = []) {
  const calls = [];
  const job = Object.values(workflows[1].jobs)[0];
  const script = job.steps.find(step => step.name === 'Publish preview link').with.script;
  const record = name => async body => { calls.push({ name, body }); };
  await vm.runInNewContext(`(async () => {${script}\n})()`, {
    process: { env: { RUNNER_TEMP: '/fixture' } },
    require(name) { return name === 'node:fs' ? { readFileSync: () => JSON.stringify(result) } : path; },
    URL, context: { repo: { owner: 'fixture', repo: 'fixture' }, payload: { pull_request: { number: 7, head: { sha: 'fixture-sha' } } } },
    core: { summary: { addHeading() { return this; }, addRaw() { return this; }, write: record('summary') } },
    github: { paginate: async () => comments, rest: {
      issues: { listComments() {}, createComment: record('create'), updateComment: record('update') },
      checks: { create: record('check') },
    } },
  });
  return calls;
}

test('미리보기 주소 안내·기존 댓글 갱신·PR 커밋 검사를 보존한다', async () => {
  const result = { status: 'success', result: { fixture: { url: 'https://fixture.web.app' } } };
  const fresh = await publishPreview(result);
  assert.equal(fresh.find(call => call.name === 'create').body.issue_number, 7);
  assert.equal(fresh.find(call => call.name === 'check').body.head_sha, 'fixture-sha');
  const repeated = await publishPreview(result, [{ id: 42, user: { login: 'github-actions[bot]' }, body: '<!-- ygo-firebase-hosting-preview -->' }]);
  assert.equal(repeated.find(call => call.name === 'update').body.comment_id, 42);
  assert.ok(!repeated.some(call => call.name === 'create'));
});

test('배포 실패·주소 없음·다른 출처 주소를 성공 안내로 게시하지 않는다', async () => {
  for (const result of [{ status: 'error' }, { status: 'success', result: {} },
    { status: 'success', result: { fixture: { url: 'https://example.invalid' } } }]) {
    await assert.rejects(publishPreview(result), /확인하지 못했습니다/);
  }
});

test('임시 인증 설정은 Git·Hosting·Functions에서 제외한다', () => {
  const filename = 'gha-creds-fixture.json';
  const ignored = spawnSync('git', ['check-ignore', filename], { cwd: root, encoding: 'utf8' });
  assert.equal(ignored.status, 0);
  const config = JSON.parse(fs.readFileSync(path.join(root, 'firebase.json'), 'utf8'));
  assert.ok(config.hosting.ignore.includes('**/gha-creds-*.json'));
  assert.ok(config.functions[0].ignore.includes('**/gha-creds-*.json'));
});

test('운영 소스 준비는 임시 인증 파일이 들어 있는 ZIP을 공개 산출물로 내보내지 않는다', async () => {
  for (const filename of ['gha-creds-fixture.json', 'nested/gha-creds-fixture.json']) {
    let readEntry = false, exportedInventory = false;
    const processFixture = {};
    const operation = vm.runInNewContext(fs.readFileSync(path.join(root, 'scripts/prepare_deployed_sources.js'), 'utf8'), {
      __dirname: path.join(root, 'scripts'), Buffer, process: processFixture, console: { log() {}, error() {} },
      fetch: async () => ({ ok: true, json: async () => ({ functions: [{
        name: 'fixture', buildConfig: { source: { storageSource: { bucket: 'fixture', object: 'fixture.zip', generation: '1' } } },
      }] }) }),
      require(name) {
        if (name === 'node:path') return path;
        if (name === 'node:os') return { tmpdir: () => '/fixture' };
        if (name === 'node:crypto') return require(name);
        if (name === 'node:fs/promises') return {
          mkdtemp: async () => '/fixture/sources', mkdir: async () => {}, chmod: async () => {},
          readFile: async () => { throw Object.assign(Error(), { code: 'ENOENT' }); },
          writeFile: async file => { if (file.endsWith('FUNCTIONS.json')) exportedInventory = true; },
        };
        if (name === 'node:child_process') return { execFileSync(_command, args) {
          if (args[0] === '-Z1') return Buffer.from(filename);
          readEntry = true; throw Error('인증 파일의 내용 접근 금지');
        } };
        if (name === './upload_card_illustrations') return { initializeStorage: () => ({ admin: {
          app: () => ({ options: { credential: { getAccessToken: async () => ({ access_token: 'fixture' }) } } }),
          storage: () => ({ bucket: () => ({ file: () => ({ download: async () => [Buffer.from('fixture-archive')] }) }) }),
        } }) };
        throw Error('실제 접근 금지');
      },
    });
    await operation;
    assert.equal(processFixture.exitCode, 1);
    assert.equal(readEntry, false);
    assert.equal(exportedInventory, false);
  }
});
