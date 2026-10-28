'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createLoginInventoryRead } = require('../services/loginInventoryRead');
const tick = () => new Promise(resolve => setImmediate(resolve));
test('같은 요청의 선행 읽기는 한 번만 시작하고 인증 장벽을 기다린다', async () => {
  let starts = 0, allowed;
  const read = createLoginInventoryRead(async (uid, authorize) => {
    starts++; assert.equal(uid, 'A'); allowed = await authorize(); return { value: { cards: {} } };
  });
  read.start('A'); read.start('A'); await tick(); assert.equal(starts, 1); assert.equal(allowed, undefined);
  await assert.rejects(read.result('A')); read.authorize('A');
  assert((await read.result('A')).value); assert(allowed); await read.close();
});
test('계정 불일치·인증 실패·요청 종료는 선행 결과를 인증 근거로 사용하지 않는다', async () => {
  for (const accepted of [null, 'B']) {
    let allowed;
    const read = createLoginInventoryRead(async (_uid, authorize) => { allowed = await authorize(); });
    read.start('A'); read.authorize(accepted); await assert.rejects(read.result('A')); await read.close(); assert.equal(allowed, false);
  }
  let allowed;
  const read = createLoginInventoryRead(async (_uid, authorize) => { allowed = await authorize(); });
  read.start('A'); await read.close(); assert.equal(allowed, false);
});
test('실패·미지원 읽기는 기존 조회에 넘기고 늦은 인증 실패 뒤 새 작업은 시작하지 않는다', async () => {
  const read = createLoginInventoryRead(async () => { throw Error('synthetic'); });
  read.start('A'); await tick(); read.authorize('A'); assert.equal(await read.result('A'), undefined); await read.close();
  let starts = 0;
  const stopped = createLoginInventoryRead(async () => { starts++; });
  stopped.authorize(null); stopped.start('A'); await stopped.close(); assert.equal(starts, 0);
});
test('동시 요청의 UID·장벽·결과는 서로 공유하지 않는다', async () => {
  const make = () => createLoginInventoryRead(async (uid, authorize) => await authorize() ? { uid } : undefined);
  const a = make(), b = make(); a.start('A'); b.start('B'); a.authorize('A');
  assert.deepEqual(await a.result('A'), { uid: 'A' }); b.authorize(null); await b.close(); await a.close();
});
