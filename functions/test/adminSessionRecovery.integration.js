'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto'), { fork } = require('node:child_process');
const { once } = require('node:events');
const { FieldValue } = require('firebase-admin/firestore');
const { open } = require('../../integration/user-migration/connection.cjs');
const { createUserInventoryWriterBinding } = require('../services/userInventoryWriterRepository');
const { createWriterJournalStore } = require('../services/user-storage/writerJournalStore');
const { main } = require('../../scripts/recover_admin_session.cjs');
const id = () => randomBytes(16).toString('hex');
function setup(runId, extra = {}) {
  const c = open(runId), f = createUserInventoryWriterBinding({ db: c.db, database: c.targetDatabase, bucket: c.bucket, FieldValue, runId,
    migration: { prepareInventoryV2: async () => {}, inventoryMigrationStatus: () => ({ status: 'complete' }) }, ...extra });
  return { ...f, c, close: () => c.close() };
}
async function interrupted(runId, backend, stage) {
  const child = fork(require.resolve('./adminSessionRecoveryChild.cjs'), [runId, backend, stage], { stdio: ['ignore','ignore','ignore','ipc'] });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 30000);
  try {
    const message = await Promise.race([once(child, 'message').then(([v]) => v), once(child, 'exit').then(() => { throw Error('child-exited-before-checkpoint'); })]);
    const done = once(child, 'exit'); child.kill('SIGKILL'); await done; return message;
  } finally { clearTimeout(timeout); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
}
for (const backend of ['legacy', 'rtdb']) for (const stage of ['before', 'after']) {
  test(`${backend} 세션 commit ${stage} 실제 프로세스 중단 뒤 미리보기·복구·반복·새 epoch 재개`, { timeout: 60000 }, async () => {
    const runId = id(), { writer, ids } = await interrupted(runId, backend, stage), f = setup(runId);
    try {
      const before = await f.transition.inspect(); assert.equal(before.externalUnresolved, 1);
      // 구형의 상위 ID 누락도 원래 digest로 연결을 증명한다.
      const journal = createWriterJournalStore({ database: f.c.targetDatabase });
      await journal.update(runId, state => { delete state.operations[ids.operation].parentExternal; return { value: state }; });
      const snapshot = (await journal.read(runId)).value;
      const nativeBefore = await f.stores[backend].receipt(snapshot.operations[ids.operation]);
      const bodyBefore = await f.stores[backend].read(snapshot.operations[ids.operation].changes[0].key);
      const preview = await f.transition.previewSessionRecovery(writer, ids);
      assert.equal(preview.receiptState, stage === 'after' ? 'committed' : 'absent');
      assert.deepEqual((await journal.read(runId)).value, snapshot);
      assert.deepEqual(await f.stores[backend].receipt(snapshot.operations[ids.operation]), nativeBefore);
      assert.deepEqual(await f.stores[backend].read(snapshot.operations[ids.operation].changes[0].key), bodyBefore);
      await assert.rejects(f.transition.recoverSession(writer, { ...ids, expectedPreview: preview.previewDigest, writersDrained: true }));
      await assert.rejects(f.transition.previewSessionRecovery(writer, { ...ids, parentRequest: id() }));
      await assert.rejects(f.transition.previewSessionRecovery(writer, { ...ids, operation: id() }));
      await assert.rejects(f.transition.previewSessionRecovery({ ...writer, epoch: writer.epoch + 1 }, ids));
      await f.transition.drain(writer);
      const plan = await f.transition.previewSessionRecovery(writer, ids);
      await assert.rejects(f.transition.recoverSession(writer, { ...ids, expectedPreview: '0'.repeat(64), writersDrained: true }));
      await assert.rejects(f.transition.recoverSession(writer, { ...ids, expectedPreview: plan.previewDigest }));
      const restored = await f.transition.recoverSession(writer, { ...ids, expectedPreview: plan.previewDigest, writersDrained: true });
      assert.equal(restored.operationState, stage === 'after' ? 'completed' : 'cancelled');
      assert.equal(restored.recoveryState, 'completed');
      assert.equal((await f.transition.inspect()).unresolved, 0);
      const repeated = await f.transition.recoverSession(writer, { ...ids, expectedPreview: restored.previewDigest, writersDrained: true });
      assert.deepEqual(repeated, restored);
      if (stage === 'before') {
        const op = (await journal.read(runId)).value.operations[ids.operation];
        await f.stores[backend].commit(op);
        assert.equal((await f.stores[backend].receipt(op)).outcome, 'cancelled');
        assert.equal(await f.adminSessions.get('a'.repeat(64)), undefined); // 늦은 저장은 영구 취소를 넘지 못함
      }
      const next = await f.transition.resume(writer, { id: id(), writersDrained: true });
      assert.equal(next.backend, backend); assert.equal(next.epoch, writer.epoch + 1);
      await assert.rejects(f.transition.previewSessionRecovery(writer, ids));
      const value = await f.adminSessions.get('a'.repeat(64)); assert.equal(!!value, stage === 'after');
    } finally { await f.close(); }
  });
}
test('실제 CLI 미리보기는 쓰지 않고 원문·ID를 출력하지 않으며 적용 플래그를 강제한다', async () => {
  const runId = id(), { writer, ids } = await interrupted(runId, 'rtdb', 'before'), f = setup(runId);
  try {
    const args = ['--writer-emulator','--backend',writer.backend,'--epoch',String(writer.epoch),'--operation',ids.operation,
      '--parent-request',ids.parentRequest,'--recovery-request',ids.recoveryRequest];
    let output='',errors=''; const runtime = { getProfileWriterBinding: () => f, closeProfileWriterRuntime: async () => {} };
    const env = { ...process.env, USER_PROFILE_WRITER_MODE: 'emulator', USER_PROFILE_WRITER_RUN_ID: runId };
    const opts = { env, createRuntime: () => runtime, stdout: v => { output+=v; }, stderr: v => { errors+=v; } };
    assert.equal(await main(args, opts), 0); assert.equal(errors,'');
    for (const value of Object.values(ids)) assert(!output.includes(value));
    assert(!output.includes('synthetic-admin')); assert.equal(JSON.parse(output).applied,false);
    assert.equal(await main([...args,'--apply'],opts),2);
    assert.equal((await f.transition.inspect()).externalUnresolved,1);
  } finally { await f.close(); }
});

test('복구 완료 ACK 유실 뒤 새 연결·같은 복구 ID로 상위 요청을 종료한다', async()=>{
 const runId=id(),{writer,ids}=await interrupted(runId,'rtdb','after');let fail=true;
 const f=setup(runId,{onCheckpoint:async stage=>{if(stage==='captured'&&fail){fail=false;throw Error('synthetic-recovery-ack-loss');}}});
 try {await f.transition.drain(writer);const p=await f.transition.previewSessionRecovery(writer,ids);
 await assert.rejects(f.transition.recoverSession(writer,{...ids,expectedPreview:p.previewDigest,writersDrained:true}));
 const other=setup(runId);try {const next=await other.transition.previewSessionRecovery(writer,ids);assert.equal(next.operationState,'completed');
 await other.transition.recoverSession(writer,{...ids,expectedPreview:next.previewDigest,writersDrained:true});assert.equal((await other.transition.inspect()).unresolved,0);
 }finally{await other.close();}}finally{await f.close();}
});
test('종료 확인을 어기고 늦은 자식 작업이 추가되면 상위 요청을 원자적으로 해제하지 않는다',async()=>{
 const runId=id(),{writer,ids}=await interrupted(runId,'rtdb','after');let f,once=true;
 f=setup(runId,{onCheckpoint:async stage=>{if(stage==='captured'&&once){once=false;const key='session/'+'a'.repeat(64),current=await f.stores.rtdb.read(key);
 await f.transition.prepare(writer,id(),[{...current,token:current.token}],null,{resources:[key],details:{kind:'session',action:'set'},parentExternal:ids.parentRequest});}}});
 try{await f.transition.drain(writer);const p=await f.transition.previewSessionRecovery(writer,ids);
 await assert.rejects(f.transition.recoverSession(writer,{...ids,expectedPreview:p.previewDigest,writersDrained:true}),{code:'WRITER_OUTCOME_UNRESOLVED'});
 assert.equal((await f.transition.inspect()).externalUnresolved,1);
 }finally{await f.close();}
});

test('영수증 없이 현재 세션 token이 달라졌다면 미리보기와 적용은 원문을 보존하고 중단한다',async()=>{
 const runId=id(),{writer,ids}=await interrupted(runId,'rtdb','before'),f=setup(runId);
 try{const store=require('../services/user-storage/adminSessionStore').createAdminSessionStore({database:f.c.targetDatabase});
 const value={uid:'synthetic-other-admin',lastActivity:Date.now(),expiresAt:Date.now()+3600000};await store.set('a'.repeat(64),value);
 await assert.rejects(f.transition.previewSessionRecovery(writer,ids),{code:'WRITER_SESSION_RECOVERY_CONFLICT'});
 assert.deepEqual(await store.get('a'.repeat(64)),value);assert.equal((await f.transition.inspect()).externalUnresolved,1);
 }finally{await f.close();}
});
