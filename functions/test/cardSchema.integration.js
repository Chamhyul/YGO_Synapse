// firebase emulators:exec --only firestore --project demo-card-schema "node functions/test/cardSchema.integration.js"
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
assert.match(process.env.FIRESTORE_EMULATOR_HOST || '', /^(127\.0\.0\.1|localhost):\d+$/);
assert.equal(process.env.GCLOUD_PROJECT, 'demo-card-schema');
const { db, admin } = require('../config/firebase');
const { stageCardWrite } = require('../services/cardWriteService');
const { toRuntimeInfo } = require('../utils/cardSchema');
const stateRef = db.collection('system').doc('cardIllustrationsMigration');
const ref = db.collection('cards').doc('10007');
let fetchFails = false;
let enqueued = 0;
const mod = { exports: {} };
const filename = path.join(__dirname, '../services/cardIllustrationsMigrationService.js');
vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
  module: mod, exports: mod.exports, console, Date, AbortSignal,
  fetch: async () => fetchFails
    ? { status: 429, ok: false }
    : { status: 200, ok: true, text: async () => '<div id="cardname">카드</div><div id="thumbnail"><img src="?ciid=1"><img src="?ciid=15"></div>' },
  require(name) {
    if (name === 'firebase-admin/functions') return { getFunctions: () => ({ taskQueue: () => ({ enqueue: async () => { enqueued++; } }) }) };
    if (name === '../config/firebase') return { ...require('../config/firebase'), db: {
      collection: db.collection.bind(db),
      // VM의 Promise를 호스트 Promise로 감싸 SDK의 instanceof 검사를 통과시킵니다.
      runTransaction: callback => db.runTransaction(async transaction => await callback(transaction)),
    } };
    return require(path.resolve(path.dirname(filename), name));
  },
}, { filename });
const migration = mod.exports;

(async () => {
  await ref.set({ info: { 0: ['검증 카드', 2, { 'NO-1': ['팩', 'N'] }, '효과', ''], 10: 0, 11: [5, 1], 12: 4 }, names: ['검증 카드'], custom: '보존' });
  const started = await migration.startCardIllustrationsMigration();
  assert.equal(started.httpStatus, 202);
  fetchFails = true;
  await migration.processCardIllustrationsMigration({ runId: started.runId });
  let state = (await stateRef.get()).data();
  assert.equal(state.status, 'failed');
  assert.equal(state.lastDocId, null);
  assert.equal(state.failedDocId, '10007');
  assert.equal((await ref.get()).data().info[0][1], 2);

  fetchFails = false;
  const resumed = await migration.startCardIllustrationsMigration();
  assert.equal(resumed.resumed, true);
  await migration.processCardIllustrationsMigration({ runId: resumed.runId });
  const card = (await ref.get()).data();
  assert.equal(card.schemaVersion, 2);
  assert.equal(card.info[0], undefined);
  assert.equal(card.info[10], undefined);
  assert.deepEqual(card.info.ko.ciid, [1, 15]);
  assert.equal(card.info.lv, 4);
  assert.deepEqual(card.info.properties, ['Xyz', 'Effect']);
  assert.equal(card.custom, '보존');
  assert.equal(card.info.ko.text, '효과');
  assert.deepEqual(toRuntimeInfo(card.info)[0], ['검증 카드', [1, 15], { 'NO-1': ['팩', 'N'] }, '효과', '']);
  state = (await stateRef.get()).data();
  assert.equal(state.lastDocId, '10007');
  assert.equal(state.updatedCount, 1);
  await migration.processCardIllustrationsMigration({ runId: resumed.runId });
  assert.equal((await stateRef.get()).data().status, 'completed');

  const batch = db.batch();
  stageCardWrite(batch, '10007', { info: { 1: ['日本語', [2, 18], {}, '文章', ''] } });
  await batch.commit();
  const merged = (await ref.get()).data();
  assert.deepEqual(merged.info.ja.ciid, [2, 18]);
  assert.equal(merged.info.ko.name, '검증 카드');
  assert.equal(merged.info.lv, 4);
  assert.ok(enqueued >= 3);
  console.log('실제 Firestore 검증 통과: 구조 변환, ciid 저장, 숫자 키 제거, 일반 저장 병합, 실패 커서 보존 및 재개');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => admin.app().delete());
