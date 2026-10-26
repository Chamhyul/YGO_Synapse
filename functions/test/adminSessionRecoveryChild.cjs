'use strict';
// 격리 demo 에뮬레이터 전용. 부모가 지정한 체크포인트에서 SIGKILL한다.
const { FieldValue } = require('firebase-admin/firestore');
const { open } = require('../../integration/user-migration/connection.cjs');
const { createUserInventoryWriterBinding } = require('../services/userInventoryWriterRepository');
const { accountResource } = require('../services/user-storage/accountResource');
const { randomBytes } = require('node:crypto');
const [runId, backend, stage] = process.argv.slice(2);
const ids = { operation: randomBytes(16).toString('hex'), parentRequest: randomBytes(16).toString('hex'), recoveryRequest: randomBytes(16).toString('hex') };
(async () => {
  const c = open(runId), f = createUserInventoryWriterBinding({ db: c.db, database: c.targetDatabase, bucket: c.bucket, FieldValue, runId,
    migration: { prepareInventoryV2: async () => {}, inventoryMigrationStatus: () => ({ status: 'complete' }) } });
  await f.initialize();
  if (backend === 'rtdb') { const w = await f.transition.route(); await f.transition.copy(w); await f.transition.drain(w); await f.transition.activate(w); }
  const writer = await f.transition.route(), key = 'session/' + 'a'.repeat(64), uid = 'synthetic-admin';
  const resources = [key, accountResource(uid)];
  await f.transition.beginExternal(writer, ids.parentRequest, [`sessionRequest/${ids.parentRequest}`, ...resources]);
  const before = await f.stores[backend].read(key);
  await f.transition.prepare(writer, ids.operation, [{ key, exists: true, token: before.token,
    value: { uid, lastActivity: Date.now(), expiresAt: Date.now() + 3600000 } }], null,
  { resources, details: { kind: 'session', action: 'set' }, parentExternal: ids.parentRequest });
  const commit = f.stores[backend].commit;
  f.stores[backend].commit = async op => {
    if (stage === 'after') await commit(op);
    process.send({ ready: true, writer, ids });
    await new Promise(() => {});
  };
  await f.transition.execute(writer, ids.operation);
})().catch(() => { process.exitCode = 1; process.disconnect?.(); });
