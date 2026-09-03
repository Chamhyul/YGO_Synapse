// 이 파일은 demo 프로젝트의 로컬 에뮬레이터에서만 실행할 수 있습니다.
const assert = require('node:assert/strict');
if (process.env.GCLOUD_PROJECT !== 'demo-ygo-indexes' ||
    process.env.FIRESTORE_EMULATOR_HOST !== '127.0.0.1:8181' ||
    process.env.FIREBASE_STORAGE_EMULATOR_HOST !== '127.0.0.1:9299') {
  throw Error('격리된 demo 에뮬레이터가 필요합니다. 운영 실행을 금지합니다.');
}
process.env.STORAGE_BUCKET = 'demo-ygo-indexes.appspot.com';
const { db, admin, getBucket } = require('../config/firebase');
const { saveCardAndQueueIndex } = require('../services/cardWriteService');
const service = require('../services/cardIndexService');
const { findCard } = require('../services/cardQueryService');
const card = (name, number) => ({ names: [name], numbers: [number], info: { 0: [name, 1, { [number]: ['팩', 'N'] }] } });
(async()=>{
  await saveCardAndQueueIndex('1',card('기존','OLD'));
  assert.equal((await db.collection('cards').doc('1').get()).exists,true);
  assert.equal((await db.collection('pendingCardIndexUpdates').doc('1').get()).exists,true);
  await service.rebuildCardNames();
  await service.processPendingCardIndexes();
  assert.equal((await db.collection('pendingCardIndexUpdates').get()).empty,true);
  assert.equal((await findCard({ number: 'OLD' })).cid, '1');
  await saveCardAndQueueIndex('1',card('최신','NEW'));
  await service.processPendingCardIndexes();
  assert.equal(await findCard({ number: 'OLD' }), null);
  assert.equal((await findCard({ number: 'NEW' })).cid, '1');
  // Storage 에뮬레이터의 업로드 API는 ifGenerationMatch를 구현하지 않습니다.
  // 충돌 시 중단·기록 보존 및 SDK 전달 옵션은 단위 테스트에서 별도 검증합니다.
  const [manifest]=await getBucket().file('public/cardNames.json').download();
  assert.deepEqual(JSON.parse(manifest).names,['최신']);
  console.log('Firestore·Storage 실제 SDK 통합 검증 완료: 원자적 저장, 전체 복구, 목록 갱신, 대기 기록 삭제');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{await admin.app().delete();});
