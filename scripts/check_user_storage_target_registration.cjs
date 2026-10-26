'use strict';
const fs = require('node:fs');
const path = require('node:path');

function validate({ projectId, targets }) {
  const fail = () => { throw new Error('승인된 운영 RTDB 대상 등록을 확인할 수 없습니다. 배포를 중단합니다.'); };
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId || '') || projectId.startsWith('demo-')
      || !Array.isArray(targets) || targets.length !== 1) fail();
  const target = targets[0];
  if (!target || Object.keys(target).sort().join(',') !== 'databaseURL,id,instanceId,location,projectId,writerRunId'
      || target.id !== 'user-data' || target.projectId !== projectId
      || target.instanceId !== `${projectId}-default-rtdb` || target.location !== 'asia-southeast1'
      || target.databaseURL !== `https://${target.instanceId}.${target.location}.firebasedatabase.app/`
      || !/^[a-f0-9]{32}$/.test(target.writerRunId || '')) fail();
  return { targets: 1, valid: true };
}

function main(args = process.argv.slice(2), root = path.resolve(__dirname, '..')) {
  if (args.length !== 2 || args[0] !== '--project') throw new Error('사용법: --project <배포 프로젝트>');
  const configured = JSON.parse(fs.readFileSync(path.join(root, '.firebaserc'), 'utf8')).projects?.default;
  if (configured !== args[1]) throw new Error('기본 프로젝트와 배포 프로젝트가 다릅니다.');
  const { PRODUCTION_TARGETS } = require(path.join(root, 'functions/config/userStorageTargets.js'));
  const result = validate({ projectId: configured, targets: PRODUCTION_TARGETS });
  console.log(JSON.stringify(result));
  return result;
}

module.exports = { validate, main };
if (require.main === module) main();
