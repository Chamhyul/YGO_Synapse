'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const yaml = require('../functions/node_modules/js-yaml');
const root = path.resolve(process.argv[2] || '.');
const role = process.argv[3] || 'main';
assert.ok(['main', 'card'].includes(role));
let count = 0;
function inspect(directory, relative = '') {
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, item.name), name = relative + item.name;
    assert.ok(!item.isSymbolicLink(), '심볼릭 링크: ' + name);
    assert.ok(!['.git', 'node_modules', 'private', 'docs', '.firebase', 'previews', '.runtimeconfig.json'].includes(item.name), '게시 제외 경로: ' + name);
    assert.ok(!/^(\.env|\.secret)/i.test(item.name) || item.name === '.env.example', '설정 파일: ' + name);
    assert.ok(!/\.(pem|p12|log)$/i.test(item.name) && !/^(gha-creds-)/i.test(item.name)
      && !/service[-_]?account.*\.json$/i.test(item.name), '자격증명/로그 경로: ' + name);
    if (item.isDirectory()) inspect(file, name + '/');
    else {
      count++;
      assert.ok(fs.statSync(file).size < 100 * 1024 * 1024, '일반 Git 게시 크기 상한: ' + name);
      if (/\.(js|cjs|json|md|yml|yaml|html|txt|example|disabled)$/.test(item.name)) {
        const text = fs.readFileSync(file, 'utf8');
        assert.ok(!/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)
          && !/\b(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|ya29\.[A-Za-z0-9_-]{40,})/.test(text), '비밀값 형태: ' + name);
      }
    }
  }
}
inspect(root);
for (const file of ['README.md', 'AGENTS.md', 'LICENSE', '.env.example', '.gitignore', '.dockerignore',
  'Dockerfile', 'package.json', 'package-lock.json', 'repository-publication.json',
  'legal/dependencies.json', 'legal/dependency-license-texts.txt']) {
  assert.ok(fs.existsSync(path.join(root, file)), '필수 공개 파일: ' + file);
}
const names = { main: 'YGO_Synapse_Service', card: 'YGO_Synapse_Cards' };
assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'repository-publication.json'))), {
  format: 1, name: names[role], visibility: 'private', history: 'new-root',
  sourceRepository: 'https://github.com/Chamhyul/YGO_Synapse', preserveSourceRepository: true,
  companionRepository: names[role === 'main' ? 'card' : 'main'], automation: 'tests-only',
});
const workflows = path.join(root, '.github/workflows');
assert.deepEqual(fs.readdirSync(workflows).sort(), ['ci.yml']);
const ci = yaml.load(fs.readFileSync(path.join(workflows, 'ci.yml'), 'utf8'));
assert.deepEqual(ci.permissions, { contents: 'read' });
assert.deepEqual(ci.on, ['push', 'pull_request', 'workflow_dispatch']);
const steps = ci.jobs.tests.steps;
assert.equal(steps[0].uses, 'actions/checkout@v4'); assert.equal(steps[0].with['persist-credentials'], false);
for (const step of steps.slice(1)) {
  assert.ok(/^docker (build -t ygo-(main|card)-service:ci \.|run --rm --network none ygo-(main|card)-service:ci [\w ./-]+)$/.test(step.run), '허용하지 않은 CI 명령');
}
if (role === 'main') {
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'card-service.lock.json'))),
    JSON.parse(fs.readFileSync(path.join(root, 'functions/services/card-service/release.json'))));
  for (const file of ['firebase-hosting-merge.yml', 'firebase-hosting-pull-request.yml', 'sync-card-illustrations.yml']) {
    assert.ok(fs.existsSync(path.join(root, 'operations/workflows', file + '.disabled')));
  }
  const compose = yaml.load(fs.readFileSync(path.join(root, 'integration/read/compose.yaml'), 'utf8'));
  assert.equal(compose.networks.isolated.internal, true);
  for (const service of Object.values(compose.services)) {
    assert.equal(service.ports, undefined); assert.equal(service.volumes, undefined);
  }
}
console.log(`${names[role]} 게시 파일 ${count}개: 비공개·새 이력·기존 저장소 보존·제외 경로·비밀값 형태·실행/고지 파일·검사 전용 CI 확인`);
