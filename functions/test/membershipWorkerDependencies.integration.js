'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { open } = require('../../integration/user-migration/connection.cjs');
const { deferredBucket, deferredFirestore } = require('../services/userProfileWriterRuntime');

test('worker의 지연 의존성은 실제 emulator SDK의 Firestore 트랜잭션·Storage 저장과 조회를 보존한다', async () => {
  const connection = open(randomBytes(16).toString('hex'));
  let databases = 0, buckets = 0;
  const db = deferredFirestore(() => { databases++; return connection.db; });
  const bucket = deferredBucket(connection.bucket.name, () => { buckets++; return connection.bucket; });
  try {
    const collection = db.collection('workerDependencies');
    assert.equal(databases, 0); assert.equal(buckets, 0);
    const ref = collection.doc('synthetic');
    await ref.set({ count: 1 });
    await db.runTransaction(async transaction => {
      const value = await transaction.get(ref);
      transaction.update(ref, { count: value.data().count + 1 });
    });
    assert.equal((await collection.where('count', '==', 2).get()).size, 1);
    const file = bucket.file('worker-dependencies.txt');
    await file.save('synthetic', { resumable: false });
    assert.equal((await file.download())[0].toString(), 'synthetic');
    assert.equal((await bucket.getFiles())[0].length, 1);
    assert.equal(databases, 1); assert.equal(buckets, 1);
    await file.delete(); await ref.delete();
  } finally { await connection.close(); }
});
