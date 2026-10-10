'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Docker 이미지에 고정 설치된 CLI로 실제 별도 프로세스 분석 경로를 검사한다.
const cli = '/usr/local/lib/node_modules/firebase-tools/lib/';
const { Delegate } = require(`${cli}deploy/functions/runtimes/node`);
const { loadFirebaseEnvs } = require(`${cli}functions/env`);
const root = path.resolve(__dirname, '..');
const account = 'card-worker@ygo-synapse.iam.gserviceaccount.com';
const targets = ['autoCrawlFull', 'autoCrawlQuick', 'autoCrawlTask',
  'processCardIndexTask', 'migrateCardNumbersTask', 'migrateCardIllustrationsTask'].sort();

for (const { project, flags, expected, label } of [
  { project: 'ygo-synapse', flags: {}, expected: targets, label: '운영 프로젝트의6개 함수' },
  { project: 'demo-ygo', flags: {}, expected: [], label: '미등록 프로젝트' },
  { project: 'ygo-synapse', flags: { FUNCTIONS_EMULATOR: 'true' }, expected: [], label: '로컬 에뮬레이터' },
]) {
  test(`실제 Firebase CLI 함수 분석: ${label}의 실행 계정`, { timeout: 30000 }, async () => {
    const config = { projectId: project, storageBucket: `${project}.firebasestorage.app` };
    const env = { ...loadFirebaseEnvs(config, project), ...flags };
    const build = await new Delegate(project, root, path.join(root, 'functions'), 'nodejs24')
      .discoverBuild({ firebase: config }, env);
    const selected = Object.entries(build.endpoints)
      .filter(([, endpoint]) => endpoint.serviceAccount === account)
      .map(([name]) => name).sort();
    assert.deepEqual(selected, expected);
    for (const [name, endpoint] of Object.entries(build.endpoints)) {
      if (!expected.includes(name)) assert.ok(!endpoint.serviceAccount, `${name}의 계정이 바뀌면 안 됩니다.`);
    }
  });
}
