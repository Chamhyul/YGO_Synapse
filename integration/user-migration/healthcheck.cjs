'use strict';
const endpoints = [
  ['http://127.0.0.1:9000/.json?ns=demo-user-migration-default-rtdb', [200, 401, 403]],
  // 빈/미지원 목록의404도 해당 에뮬레이터가 HTTP 요청을 받은 것으로 확인한다.
  ['http://127.0.0.1:8080/v1/projects/demo-user-migration/databases/(default)/documents', [200, 404]],
  ['http://127.0.0.1:9199/storage/v1/b?project=demo-user-migration', [200, 404]],
  ['http://127.0.0.1:9099/emulator/v1/projects/demo-user-migration/config', [200]],
];
Promise.all(endpoints.map(async ([url, accepted]) => {
  const response = await fetch(url, { headers: { Authorization: 'Bearer owner' }, signal: AbortSignal.timeout(1500) });
  if (!accepted.includes(response.status)) throw new Error('시험 에뮬레이터 준비 중');
})).then(() => { process.exitCode = 0; }, () => { process.exitCode = 1; });
