'use strict';
const { measure } = require('./inventoryRequestTiming');
const { fingerprint, content } = require('./userMigrationRehearsal');
const { encodeKey, decodeKey, encodeValue, decodeValue } = require('./user-storage/codec');
const { createRecordStore } = require('./user-storage/recordStore');
const { createStorageAccess } = require('./user-storage/storageAccess');
const { inventoryPayloadCodec } = require('./user-storage/inventoryCodec');
const { manifestPayloadCodec, splitInventory, hydrateInventory, cardBlobPath } = require('./user-storage/inventoryManifest');
const { createProfileWriterAdapters } = require('./userProfileWriterAdapters');
const { buildApiSummary } = require('./user-storage/inventoryApiSummary');
const fail = code => Object.assign(new Error('인벤토리 writer의 원본 버전과 영수증을 대조해야 합니다.'), { code });
const copy = value => JSON.parse(JSON.stringify(value));
const emptyInventory = () => ({ version: 3, updatedAt: new Date().toISOString(), amount: 0, locations: {}, rarities: {}, cards: {} });
function checkInventoryKey(key) {
  if (typeof key !== 'string' || !key.startsWith('inventory/')) throw fail('INVENTORY_WRITER_INVALID_KEY');
  const uid = key.slice(10);
  if (!uid || uid.length > 128 || /[/\u0000-\u001f\u007f]/.test(uid) || Buffer.from(uid).toString() !== uid) throw fail('INVENTORY_WRITER_INVALID_KEY');
  encodeKey(uid); return uid;
}
const refs = manifest => Object.entries(manifest.cards || {}).filter(([key]) => key.startsWith('h'));
function clearedManifest(previous, now = '1970-01-01T00:00:00.000Z') {
  const header = inventoryPayloadCodec.encode({ inventory: { ...emptyInventory(), updatedAt: now }, locationState: {
    locationNames: {}, nextLocationId: previous?.header?.nextLocationId ?? previous?.legacy?.locationState?.nextLocationId ?? 1,
  } });
  delete header.cards;
  return { type: 'inventory-parts', version: 1, header, cards: { count: 0 } };
}
function splitStable(inventory, locationState) {
  const candidate = splitInventory({ inventory, ...(locationState ? { locationState } : {}) }, { uid: 'writer-plan' });
  for (const blob of candidate.blobs) {
    blob.token = fingerprint(blob.value).slice(0, 32);
    candidate.manifest.cards[blob.hash].v = blob.token;
  }
  const summary = buildApiSummary(candidate.manifest, inventory);
  if (summary) candidate.manifest.apiSummary = summary;
  return candidate;
}
function validateBundle(value) {
  if (!value || typeof value.exists !== 'boolean' || Object.keys(value).length !== 2 || !value.manifest) throw fail('INVENTORY_WRITER_INVALID_RECORD');
  manifestPayloadCodec.encode(value.manifest);
  if (!value.exists && refs(value.manifest).length) throw fail('INVENTORY_WRITER_INVALID_RECORD');
  return value;
}
function verifyInventoryBlob(value, token) {
  if (fingerprint(value).slice(0, 32) !== token) throw fail('INVENTORY_WRITER_CARD_VERSION_MISMATCH');
}
const absent = key => ({ key, exists: false, token: '0' });
function createInventoryWriterAdapters({ db, FieldValue, database, bucket, timeoutMs = 10000, onAmbiguousWrite } = {}) {
  if (!bucket?.file || !bucket?.getFiles) throw fail('INVENTORY_WRITER_INVALID_DEPENDENCIES');
  const access = createStorageAccess({ database, timeoutMs, onAmbiguousWrite });
  const guarded = (promise, write = false) => access.guarded(promise, write);
  let resolveBlob;
  async function immutable(file, value, expectedDigest) {
    const stable = copy(value), body = JSON.stringify(stable);
    const present = await optionalFile(file);
    if (present !== null) { if (fingerprint(present) !== (expectedDigest || fingerprint(stable))) throw fail('INVENTORY_WRITER_RECEIPT_CONFLICT'); return stable; }
    try { await guarded(file.save(body, { resumable: false, contentType: 'application/json', preconditionOpts: { ifGenerationMatch: 0 } }), true); }
    catch (error) {
      if (Number(error.code) !== 412) throw error;
      const existing = JSON.parse((await guarded(file.download()))[0].toString());
      if (fingerprint(existing) !== (expectedDigest || fingerprint(stable))) throw fail('INVENTORY_WRITER_RECEIPT_CONFLICT');
    }
    return stable;
  }
  async function optionalFile(file) {
    try { return JSON.parse((await guarded(file.download()))[0].toString()); }
    catch (error) { if (Number(error.code) === 404) return null; throw error; }
  }
  const legacy = (() => {
    // 파일과 별도 DB receipt 사이의 간극을 없앤다. 공개 지점은 불변 파일을 참조하는
    // Firestore head+receipt transaction이며 기존 JSON은 첫 읽기/감사용 원본으로 보존한다.
    const mapping = { users: 'inventoryWriterHeads', userProfileWriterMetadata: 'inventoryWriterMetadata',
      userProfileWriterReceipts: 'inventoryWriterReceipts' };
    const native = createProfileWriterAdapters({ db: { collection: name => db.collection(mapping[name]),
      runTransaction: callback => db.runTransaction(callback) }, database, FieldValue, timeoutMs, onAmbiguousWrite }).legacy;
    const fileFor = uid => bucket.file(`users/${uid}/inventory.json`);
    const snapshotFile = (uid, id) => bucket.file(`inventoryWriter/snapshots/${encodeKey(uid)}/${id}.json`);
    const blobFile = (uid, hash, token) => bucket.file(`${cardBlobPath(uid, hash, token, { partsPath: 'inventoryWriter/cards' })}.json`);
    const fsKey = key => `fs/users/${checkInventoryKey(key)}`;
    async function metadata(uid) {
      try { return (await guarded(fileFor(uid).getMetadata()))[0]; }
      catch (error) { if (Number(error.code) === 404) return null; throw error; }
    }
    function convert(key, record) {
      return { key, exists: record.exists, token: record.token,
        ...(record.exists ? { value: validateBundle(decodeValue(record.value.payload)) } : {}) };
    }
    async function state(key) {
      const uid = checkInventoryKey(key), record = await native.read(fsKey(key)), marker = await metadata(uid);
      const generation = marker ? String(marker.generation) : '0';
      if (record.exists) {
        if (record.value.sourceGeneration !== generation) throw fail('INVENTORY_WRITER_UNTRACKED_WRITE');
        return { entry: convert(key, record), native: record, reset: record.value.reset, generation };
      }
      if (record.token !== '0') return { entry: convert(key, record), native: record, reset: 0, generation };
      if (!marker) return { entry: absent(key), native: record, reset: 0, generation };
      // generation 지정 읽기가 에뮬레이터에서 404이면 다시 대조하고, 잘못된 본문은 보존한다.
      const inventory = JSON.parse((await guarded(bucket.file(fileFor(uid).name, { generation }).download()))[0].toString());
      if (!inventory || typeof inventory !== 'object' || Array.isArray(inventory) || Number(inventory.version || 1) > 3
          || inventory.cards && (typeof inventory.cards !== 'object' || Array.isArray(inventory.cards))) throw fail('INVENTORY_WRITER_INVALID_RECORD');
      return { entry: { key, exists: true, token: `g:${generation}`, value: { exists: true, manifest: splitStable(inventory).manifest } },
        native: record, reset: 0, generation, inventory };
    }
    async function observed(key) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try { return await state(key); } catch (error) { if (Number(error.code) !== 404 || attempt === 2) throw error; }
      }
    }
    async function stage(uid, blobs) { for (const blob of blobs) { verifyInventoryBlob(blob.value, blob.token); await immutable(blobFile(uid, blob.hash, blob.token), blob.value); } }
    async function blob(uid, hash, token) {
      const saved = await optionalFile(blobFile(uid, hash, token)); if (saved) { verifyInventoryBlob(saved, token); return saved; }
      const current = await observed(`inventory/${uid}`);
      const found = current.inventory && splitStable(current.inventory).blobs.find(item => item.hash === hash && item.token === token);
      if (!found) throw fail('USER_STORAGE_MISSING_CARD_VERSION'); return found.value;
    }
    const command = (op, change) => ({ ...op, changes: [change], details: { kind: 'profile', serverTimestampPaths: [] } });
    const reference = op => command(op, { ...op.changes[0], key: fsKey(op.changes[0].key) });
    async function proof(op) { return native.receipt(reference(op)); }
    async function write(op, projection = false, expected) {
      access.ensureUsable(); if (await proof(op)) return;
      const change = op.changes[0], uid = checkInventoryKey(change.key), current = await observed(change.key);
      if (current.entry.token !== change.token || expected && content(current.entry) !== content(expected)) {
        if (projection) throw fail('INVENTORY_WRITER_TARGET_CONFLICT');
        if (current.entry.token.startsWith('g:') || change.token.startsWith('g:') && current.native.token === '0') throw fail('INVENTORY_WRITER_UNTRACKED_WRITE');
        // 같은 head에 선행 공개가 있으면 원래 token의 CAS가 영구 취소된다.
        const token = change.token.startsWith('g:') ? '0' : change.token;
        await native.commit(command(op, { key: fsKey(change.key), exists: current.native.exists, token,
          ...(current.native.exists ? { value: current.native.value } : {}) }));
        return;
      }
      const value = change.exists ? validateBundle(change.value) : undefined;
      const finalRefs = value ? refs(value.manifest) : [];
      const finalTokens = new Map(finalRefs.map(([hash, ref]) => [hash, ref.v]));
      const staged = new Map(), finalBlobs = {};
      // 같은 write 안에서만 불변 버전의 저장 결과를 재사용한다. 원본 보존용 버전도
      // 계속 저장하며, 같은 주소에 다른 본문을 보내면 전체 지문으로 충돌을 확인한다.
      async function stageKnown(blobs) {
        for (const blob of blobs) {
          const digest = fingerprint(blob.value), key = `${blob.hash}/${blob.token}`;
          if (digest.slice(0, 32) !== blob.token) throw fail('INVENTORY_WRITER_CARD_VERSION_MISMATCH');
          if (staged.has(key)) {
            if (staged.get(key) !== digest) throw fail('INVENTORY_WRITER_RECEIPT_CONFLICT');
            continue;
          }
          // immutable이 이미 만드는 저장 시점의 복사본을 hydrate에도 사용한다.
          // await 중 호출자가 입력 객체를 바꾸어도 저장한 본문과 달라지지 않는다.
          const saved = await immutable(blobFile(uid, blob.hash, blob.token), blob.value, digest);
          staged.set(key, digest);
          if (finalTokens.get(blob.hash) === blob.token) finalBlobs[blob.hash] = saved;
        }
      }
      if (current.inventory) await stageKnown(splitStable(current.inventory).blobs);
      if (change.exists) {
        await stageKnown(op.details?.blobs || []);
        for (const [hash, ref] of finalRefs) if (!Object.hasOwn(finalBlobs, hash)) {
          await stageKnown([{ hash, token: ref.v, value: await resolveBlob(uid, hash, ref.v) }]);
        }
        const snapshot = fingerprint({ id: op.id, value }).slice(0, 32);
        await immutable(snapshotFile(uid, snapshot), hydrateInventory(value.manifest, finalBlobs, { uid }).inventory);
        await native.commit(command(op, { key: fsKey(change.key), exists: true, token: current.native.token,
          value: { payload: encodeValue(value), sourceGeneration: current.generation,
            reset: current.reset + (!value.exists ? 1 : 0), snapshot } }));
      } else await native.commit(command(op, { key: fsKey(change.key), exists: false, token: current.native.token }));
    }
    return { native, stage, blob, read: async key => (await observed(key)).entry,
      async capture(key) {
        const current = await observed(key), uid = checkInventoryKey(key);
        if (current.inventory) await stage(uid, splitStable(current.inventory).blobs);
        if (current.entry.exists) for (const [hash, ref] of refs(current.entry.value.manifest)) await blob(uid, hash, ref.v);
        return current.entry;
      },
      async inspect(key) { const value = await observed(key);
        if (!Number.isSafeInteger(value.reset) || value.reset < 0) throw fail('INVENTORY_WRITER_INVALID_RECORD');
        // 최초 legacy 읽기의 generation 고정 본문을 이 inspect 결과 안에서만 재사용한다.
        // entry에는 넣지 않아 전환 기록·영수증의 저장 계약은 그대로 유지한다.
        return { entry: value.entry, reset: value.reset,
          ...(value.inventory ? { sourceInventory: value.inventory } : {}) }; },
      async exists(uid) {
        const key = `inventory/${uid}`, record = await native.read(fsKey(key));
        if (record.exists) return validateBundle(decodeValue(record.value.payload)).exists;
        return record.token === '0' && await metadata(uid) !== null;
      },
      async snapshot() {
        const keys = new Set((await native.snapshot()).map(record => `inventory/${record.key.slice(9)}`));
        let query = { prefix: 'users/', autoPaginate: false, maxResults: 25 };
        while (query) {
          const [files, next] = await guarded(bucket.getFiles(query));
          for (const file of files) { const match = /^users\/([^/]+)\/inventory\.json$/.exec(file.name); if (match) keys.add(`inventory/${match[1]}`); }
          query = next;
        }
        const entries = [];
        for (const key of keys) { const current = await observed(key), uid = checkInventoryKey(key);
          if (current.inventory) await stage(uid, splitStable(current.inventory).blobs);
          if (current.entry.exists) for (const [hash, ref] of refs(current.entry.value.manifest)) await blob(uid, hash, ref.v);
          entries.push(current.entry); }
        return entries;
      },
      commit: op => write(op),
      async receipt(op) {
        const raw = await proof(op); if (!raw || raw.outcome === 'cancelled') return raw;
        return { id: op.id, digest: op.digest, changes: [convert(op.changes[0].key, raw.changes[0])], result: raw.result };
      },
      cancellationReason: op => native.cancellationReason(reference(op)),
      async fence(op) { await native.fence(reference(op)); return this.receipt(op); },
      async apply(id, entry, expected) {
        const op = { id, digest: fingerprint({ entry, expected }), changes: [{ ...entry, token: expected.token }], result: null };
        await write(op, true, expected); const receipt = await this.receipt(op);
        if (!receipt || receipt.outcome === 'cancelled' || content(receipt.changes[0]) !== content(entry)) throw fail('INVENTORY_WRITER_TARGET_CONFLICT');
        return receipt.changes[0];
      },
    };
  })();
  const rtdb = (() => {
    const receipts = createRecordStore({ database, path: 'inventoryWriterReceipts', timeoutMs, onAmbiguousWrite });
    const receiptKey = (uid, id) => `${encodeKey(uid)}:${id}`;
    async function archive(uid, raw) {
      let saved;
      try { saved = await receipts.createIfAbsent(receiptKey(uid, raw.id), raw); }
      catch (error) { if (error.code !== 'USER_STORAGE_CONFLICT') throw error; saved = await receipts.read(receiptKey(uid, raw.id)); }
      if (!saved.exists || fingerprint(saved.value) !== fingerprint(raw)) throw fail('INVENTORY_WRITER_RECEIPT_CONFLICT');
    }
    const headStore = createRecordStore({ database, path: 'inventories', timeoutMs, onAmbiguousWrite,
      payloadCodec: manifestPayloadCodec, retainOnDelete: clearedManifest, archiveReceipt: archive });
    async function native(uid) { return measure('inventory.native_read', () => headStore.read(uid)); }
    function entry(key, record) {
      if (!record.revision) return absent(key);
      const manifest = record.value?.legacy ? splitStable(record.value.legacy.inventory, record.value.legacy.locationState).manifest : record.value || clearedManifest();
      const token = `${record.revision}:${record.generation}`;
      if (!record.exists && manifest?.header?.updatedAt === 'writer-absence') return { key, exists: false, token };
      return { key, exists: true, token, value: { exists: record.exists, manifest } };
    }
    async function stage(uid, blobs) {
      for (const blob of blobs) {
        verifyInventoryBlob(blob.value, blob.token);
        const path = cardBlobPath(uid, blob.hash, blob.token);
        const result = await guarded(database.ref(path).transaction(raw => {
          if (raw !== null && fingerprint(raw) !== fingerprint(blob.value)) return undefined;
          return blob.value;
        }, undefined, false), true);
        if (!result.committed) throw fail('INVENTORY_WRITER_RECEIPT_CONFLICT');
      }
    }
    async function blob(uid, hash, token) {
      const value = await access.read(cardBlobPath(uid, hash, token)); if (value !== null) { verifyInventoryBlob(value, token); return value; }
      const current = await native(uid);
      const found = current.value?.legacy && splitStable(current.value.legacy.inventory, current.value.legacy.locationState).blobs.find(item => item.hash === hash && item.token === token);
      if (!found) throw fail('USER_STORAGE_MISSING_CARD_VERSION'); return found.value;
    }
    async function receiptFrom(op, uid, current) {
      const raw = current.commitReceipt?.id === op.id ? current.commitReceipt : (await receipts.read(receiptKey(uid, op.id))).value;
      if (raw && raw.digest !== op.digest) throw fail('INVENTORY_WRITER_RECEIPT_CONFLICT'); return raw;
    }
    async function rawReceipt(op) {
      const uid = checkInventoryKey(op.changes[0].key);
      return receiptFrom(op, uid, await native(uid));
    }
    async function write(op, projection = false, expected) {
      const change = op.changes[0], uid = checkInventoryKey(change.key), current = await native(uid);
      if (await measure('inventory.receipt_lookup', () => receiptFrom(op, uid, current))) return;
      // 영수증 조회와 같은 snapshot을 사용한다. 그 사이의 저장·초기화·fence는
      // 아래 서버 CAS가 원래 revision과 대조하고, 충돌 후 영수증은 새로 읽는다.
      const observed = entry(change.key, current);
      if (observed.token !== change.token || expected && content(observed) !== content(expected)) {
        if (projection) throw fail('INVENTORY_WRITER_TARGET_CONFLICT');
        if (!await rawReceipt(op)) await archive(uid, { id: op.id, digest: op.digest, outcome: 'cancelled', reason: 'conflict' }); return;
      }
      if (current.value?.legacy) await stage(uid, splitStable(current.value.legacy.inventory, current.value.legacy.locationState).blobs);
      const value = change.exists ? validateBundle(change.value) : { exists: false, manifest: clearedManifest(observed.value?.manifest, 'writer-absence') };
      if (projection) {
        for (const [hash, ref] of refs(value.manifest)) await stage(uid, [{ hash, token: ref.v, value: await resolveBlob(uid, hash, ref.v) }]);
      } else await measure('inventory.stage_blobs', () => stage(uid, op.details?.blobs || []));
      const commit = { operationId: op.id, operationDigest: op.digest };
      try {
        // 초기화도 불변 위치 ID 상한을 전달한다. delete retainOnDelete는 같은 head를 기반으로 한다.
        if (value.exists) return await measure('inventory.head_cas', () => headStore.compareAndSet(uid, current.revision, value.manifest, commit));
        else return await createRecordStore({ database, path: 'inventories', timeoutMs, onAmbiguousWrite,
          payloadCodec: manifestPayloadCodec, retainOnDelete: () => value.manifest, archiveReceipt: archive }).delete(uid, current.revision, commit);
      } catch (error) {
        if (error.code !== 'USER_STORAGE_CONFLICT') throw error;
        if (!await rawReceipt(op)) await archive(uid, { id: op.id, digest: op.digest, outcome: 'cancelled', reason: 'conflict' });
      }
    }
    return { native, stage, blob, exists: async uid => (await require('./user-storage/partitionedInventoryStore').createPartitionedInventoryStore({ database, timeoutMs, onAmbiguousWrite }).readMetadata(uid)).exists, read: async key => entry(key, await native(checkInventoryKey(key))),
      async capture(key) {
        const current = await this.read(key), uid = checkInventoryKey(key);
        if (current.exists) for (const [hash, ref] of refs(current.value.manifest)) await blob(uid, hash, ref.v);
        return current;
      },
      async snapshot() {
        const snapshots = []; let last;
        while (true) {
          let query = database.ref('inventories').orderByKey().limitToFirst(25); if (last) query = query.startAfter(last);
          const page = await guarded(query.get()); let count = 0;
          page.forEach(child => { const key = `inventory/${decodeKey(child.key)}`; checkInventoryKey(key); snapshots.push(key); last = child.key; count++; });
          if (count < 25) break;
        }
        const entries = []; for (const key of snapshots) { const current = await this.read(key), uid = checkInventoryKey(key);
          if (current.exists) for (const [hash, ref] of refs(current.value.manifest)) await blob(uid, hash, ref.v);
          entries.push(current); } return entries;
      },
      // 기존 commit 반환값은 유지한다. 새 정상 CAS의 서버 확정 증거만 실행 호출에 전달한다.
      async commit(op, onConfirmedReceipt) {
        const saved = await write(op);
        if (!saved || typeof onConfirmedReceipt !== 'function') return;
        // 기존 영수증·경합은 saved를 반환하지 않으므로 기존 fresh 조회 경로에 남는다.
        const proof = saved.commitReceipt, actual = entry(op.changes[0].key, saved);
        if (!proof || proof.id !== op.id || proof.digest !== op.digest || proof.outcome !== 'committed'
            || proof.revision !== saved.revision || proof.generation !== saved.generation
            || content(actual) !== content(op.changes[0])) throw fail('INVENTORY_WRITER_RECEIPT_CONFLICT');
        onConfirmedReceipt({ id: op.id, digest: op.digest, changes: [actual], result: op.result });
      },
      async receipt(op) {
        const raw = await rawReceipt(op); if (!raw) return null;
        if (raw.outcome === 'cancelled') return { id: op.id, digest: op.digest, outcome: 'cancelled' };
        if (raw.outcome !== 'committed') throw fail('INVENTORY_WRITER_RECEIPT_CONFLICT');
        return { id: op.id, digest: op.digest, changes: [{ ...op.changes[0], token: `${raw.revision}:${raw.generation}` }], result: op.result };
      },
      async cancellationReason(op) { return (await rawReceipt(op))?.reason || 'fenced'; },
      async fence(op) {
        if (await rawReceipt(op)) return this.receipt(op);
        const uid = checkInventoryKey(op.changes[0].key), current = await native(uid);
        await createRecordStore({ database, path: 'inventories', timeoutMs, onAmbiguousWrite, payloadCodec: manifestPayloadCodec,
          retainOnDelete: () => clearedManifest(undefined, 'writer-absence'), archiveReceipt: archive })
          .fence(uid, current.revision, { operationId: op.id, operationDigest: op.digest }); return this.receipt(op);
      },
      async apply(id, entry, expected) {
        const op = { id, digest: fingerprint({ entry, expected }), changes: [{ ...entry, token: expected.token }], result: null };
        await write(op, true, expected); const raw = await rawReceipt(op);
        if (!raw || raw.outcome !== 'committed') throw fail('INVENTORY_WRITER_TARGET_CONFLICT');
        return { ...entry, token: `${raw.revision}:${raw.generation}` };
      },
    };
  })();
  resolveBlob = async (uid, hash, token) => {
    try { return await rtdb.blob(uid, hash, token); }
    catch (error) { if (error.code !== 'USER_STORAGE_MISSING_CARD_VERSION') throw error; return legacy.blob(uid, hash, token); }
  };
  return { legacy, rtdb };
}
module.exports = { createInventoryWriterAdapters, checkInventoryKey, clearedManifest, splitStable, emptyInventory, verifyInventoryBlob };
