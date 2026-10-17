'use strict';
const { createHash } = require('node:crypto');
const { createRecordStore } = require('../../functions/services/user-storage/recordStore');
const { encodeKey, encodeValue, decodeValue } = require('../../functions/services/user-storage/codec');
const { createProfilePayloadCodec } = require('../../functions/services/user-storage/profileCodec');
const { inventoryPayloadCodec } = require('../../functions/services/user-storage/inventoryCodec');
const { createPartitionedInventoryStore } = require('../../functions/services/user-storage/partitionedInventoryStore');
const { validateVerificationState } = require('../../functions/services/user-storage/membershipStore');
const { validateApiAccessValue } = require('../../functions/services/user-storage/apiAccessStore');
const { createAdminSessionStore } = require('../../functions/services/user-storage/adminSessionStore');
const { createMembershipCsvStore, EMPTY_REVISION } = require('../../functions/services/user-storage/membershipCsvStore');
const { createMembershipCsvService, membershipCsvValidateMembers } = require('../../functions/services/membershipCsvService');
const { fingerprint, content } = require('../../functions/services/userMigrationRehearsal');
const fail = code => Object.assign(new Error('합성 데이터 이전을 대조해야 합니다.'), { code });
const hash = text => createHash('sha256').update(text).digest('hex');
const COLLECTIONS = ['users', 'discord_membership_verifications', 'youtube_membership_verifications', 'AdminWebSessions',
  'cardApiKeys', 'cardApiUsage', 'cardApiConfig', 'membership_csv_users', 'membership_csv_state', 'membership_csv_imports'];
const empty = key => ({ key, exists: false, token: '0' });
function checkKey(key) {
  if (typeof key !== 'string') throw fail('MIGRATION_INVALID_SNAPSHOT');
  if (key.startsWith('inventory/')) {
    const uid = key.slice(10);
    if (!uid || uid.length > 128 || Buffer.from(uid).toString() !== uid || /[\u0000-\u001f\u007f]/.test(uid)) throw fail('MIGRATION_INVALID_SNAPSHOT');
    return;
  }
  const parts = key.split('/');
  if (parts[0] !== 'fs' || !COLLECTIONS.includes(parts[1]) || !parts[2]
      || (parts.length !== 3 && !(parts.length === 5 && parts[1] === 'membership_csv_imports' && parts[3] === 'members' && parts[4]))) {
    throw fail('MIGRATION_INVALID_SNAPSHOT');
  }
}
async function documents(ref) {
  const all = []; let last;
  for (;;) {
    let query = ref.orderBy('__name__').limit(25); if (last) query = query.startAfter(last);
    const page = await query.get(); all.push(...page.docs); if (page.size < 25) break; last = page.docs.at(-1);
    if (all.length > 20000) throw fail('MIGRATION_FIXTURE_LIMIT');
  }
  return all;
}
function createLegacy(connection) {
  const { db, bucket } = connection;
  async function read(key) {
    checkKey(key);
    if (key.startsWith('inventory/')) {
      const file = bucket.file(`users/${key.slice(10)}/inventory.json`);
      try {
        const [metadata] = await file.getMetadata(), [bytes] = await bucket.file(file.name, { generation: metadata.generation }).download();
        return { key, exists: true, token: String(metadata.generation), value: JSON.parse(bytes.toString('utf8')) };
      } catch (error) { if (Number(error.code) === 404) return empty(key); throw error; }
    }
    const parts = key.slice(3).split('/'), ref = db.collection(parts.shift()).doc(parts.join('/'));
    const snapshot = await ref.get();
    return snapshot.exists ? { key, exists: true, token: `${snapshot.updateTime.seconds}:${snapshot.updateTime.nanoseconds}`, value: snapshot.data() } : empty(key);
  }
  return {
    read,
    async snapshot() {
      const keys = [];
      for (const name of COLLECTIONS) {
        for (const doc of await documents(db.collection(name))) {
          keys.push(`fs/${name}/${doc.id}`);
          if (name === 'membership_csv_imports') for (const member of await documents(doc.ref.collection('members'))) keys.push(`fs/${name}/${doc.id}/members/${member.id}`);
        }
      }
      let query = { prefix: 'users/', autoPaginate: false, maxResults: 25 };
      while (query) {
        const [files, next] = await bucket.getFiles(query);
        for (const file of files) { const match = /^users\/(.+)\/inventory\.json$/.exec(file.name); if (match) keys.push(`inventory/${match[1]}`); }
        query = next;
      }
      return Promise.all(keys.sort().map(read));
    },
    async hasReceipt(key, runId, digest, token) {
      if (key.startsWith('inventory/')) {
        if (token === '0') {
          const marker = await db.collection('migrationReceipts').doc(hash(key)).get();
          return marker.data()?.runId === runId && marker.data()?.digest === digest && marker.data()?.deleted === true;
        }
        const [metadata] = await bucket.file(`users/${key.slice(10)}/inventory.json`).getMetadata();
        return metadata.metadata?.migrationRun === runId && metadata.metadata?.migrationDigest === digest && String(metadata.generation) === token;
      }
      const receipt = await db.collection('migrationReceipts').doc(hash(key)).get();
      return receipt.data()?.runId === runId && receipt.data()?.digest === digest
        && (token === '0' ? receipt.data()?.deleted === true : token === `${receipt.updateTime.seconds}:${receipt.updateTime.nanoseconds}`);
    },
    async write(entry, { runId, expected }) {
      const current = await read(entry.key), digest = content(entry);
      if (await this.hasReceipt(entry.key, runId, digest, current.token) && content(current) === digest) return { token: current.token };
      if (current.token !== expected.token || content(current) !== content(expected)) throw fail('MIGRATION_SOURCE_CHANGED');
      if (entry.key.startsWith('inventory/')) {
        const file = bucket.file(`users/${entry.key.slice(10)}/inventory.json`);
        if (entry.exists) await file.save(JSON.stringify(entry.value), { resumable: false, contentType: 'application/json',
          metadata: { metadata: { migrationRun: runId, migrationDigest: digest } }, preconditionOpts: { ifGenerationMatch: current.token } });
        else {
          if (current.exists) await file.delete({ ifGenerationMatch: current.token });
          await db.collection('migrationReceipts').doc(hash(entry.key)).set({ runId, digest, deleted: true });
        }
      } else {
        const parts = entry.key.slice(3).split('/'), ref = db.collection(parts.shift()).doc(parts.join('/'));
        await db.runTransaction(async tx => {
          const snapshot = await tx.get(ref), token = snapshot.exists ? `${snapshot.updateTime.seconds}:${snapshot.updateTime.nanoseconds}` : '0';
          if (token !== expected.token || content(snapshot.exists ? { exists: true, value: snapshot.data() } : { exists: false }) !== content(expected)) throw fail('MIGRATION_SOURCE_CHANGED');
          if (entry.exists) tx.set(ref, entry.value); else tx.delete(ref);
          tx.set(db.collection('migrationReceipts').doc(hash(entry.key)), { runId, digest, deleted: !entry.exists });
        });
      }
      return { token: (await read(entry.key)).token };
    },
  };
}
function createDestination(connection, sourcePlan, runId) {
  const database = connection.targetDatabase, source = new Map(sourcePlan.map(item => [item.key, item]));
  const mirror = createRecordStore({ database, path: 'migrationMirror' });
  const rawStores = new Map();
  const inventory = createPartitionedInventoryStore({ database });
  function store(path, suffix = '', payloadCodec) {
    const key = `${path}/${suffix}`;
    if (!rawStores.has(key)) rawStores.set(key, createRecordStore({ database, path, suffix, ...(payloadCodec ? { payloadCodec } : {}) }));
    return rawStores.get(key);
  }
  function target(key, value) {
    checkKey(key);
    const [kind, collection, id] = key.split('/');
    if (kind === 'inventory') return { store: store('inventories', '', inventoryPayloadCodec), id: key.slice(10),
      encode: v => ({ inventory: v, locationState: { locationNames: {}, nextLocationId: 1 } }), decode: v => v.inventory };
    if (collection === 'users') return { store: store('users', 'profile', createProfilePayloadCodec()), id };
    if (collection === 'AdminWebSessions') return { store: store('adminSessions'), id };
    if (collection === 'cardApiKeys') return { store: store('apiAccess/keys'), id,
      encode: policy => validateApiAccessValue({ policy, usage: source.get(`fs/cardApiUsage/${id}`)?.value || null }), decode: v => v.policy };
    return null;
  }
  async function readMirror(key) { const record = await mirror.read(key); return record.exists ? record.value : undefined; }
  async function put(store, id, value) {
    const current = await store.read(id);
    if (current.revision !== 0) { if (!current.exists || fingerprint(current.value) !== fingerprint(value)) throw fail('MIGRATION_TARGET_CONFLICT'); return current; }
    return store.compareAndSet(id, 0, value);
  }
  async function initCsv() {
    const marker = store('migrationProjection'), saved = await marker.read('csv'); if (saved.exists) return;
    const state = source.get('fs/membership_csv_state/current')?.value;
    const prefix = state ? `fs/membership_csv_imports/${state.revision}/members/` : 'fs/membership_csv_users/';
    const members = [...source.values()].filter(item => item.key.startsWith(prefix)).map(item => ({ ...item.value, channelId: item.key.split('/').at(-1) }));
    let activeId;
    if (members.length) {
      membershipCsvValidateMembers(members);
      if (state && state.count !== members.length) throw fail('MIGRATION_INVALID_CSV');
      const csv = createMembershipCsvStore({ database }), service = createMembershipCsvService({ store: csv });
      activeId = state?.revision || hash(`legacy:${runId}`).slice(0, 32);
      const actor = source.get(`fs/membership_csv_imports/${activeId}`)?.value?.actor || 'synthetic-migration';
      const preview = await service.preview({ members });
      await service.apply({ members, ...preview, operationId: activeId }, actor);
      // 기존 갱신 시각을 API 표시값으로 보존한다.
      const control = store('membershipCsv/control');
      await control.update('current', value => ({ value: { ...value, active: { ...value.active, updatedAt: state?.updatedAt ?? null }, operations: {} } }));
    }
    // 퇴역·실패·미완료 후보의 원문도 보존하고 기존 작업 상태 조회에 연결한다.
    for (const entry of source.values()) if (/^fs\/membership_csv_imports\/[a-f0-9]{32}$/.test(entry.key)) {
      const id = entry.key.split('/').at(-1), original = entry.value;
      const archive = { binding: original.binding, actor: original.actor, startedAt: original.startedAt,
        revision: EMPTY_REVISION, status: original.status };
      if (original.status === 'completed') {
        const prefix = `${entry.key}/members/`, members = membershipCsvValidateMembers([...source.values()].filter(item => item.key.startsWith(prefix)).map(item => item.value));
        await put(store('membershipCsv/candidates'), id, { members, fingerprint: hash(JSON.stringify(members)) });
        archive.completedAt = original.result.updatedAt; archive.legacyResult = original.result;
      }
      await put(store('membershipCsv/operations'), id, archive);
    }
    await put(marker, 'csv', { activeId: activeId || '', sourceState: state || null });
  }
  return {
    inventory, database,
    async write(entry) {
      const previous = await readMirror(entry.key);
      if (previous && content(previous) !== content(entry)) throw fail('MIGRATION_TARGET_CONFLICT');
      const selected = target(entry.key, entry.value);
      if (selected && entry.exists) await put(selected.store, selected.id, selected.encode ? selected.encode(entry.value) : entry.value);
      if (entry.key.startsWith('fs/AdminWebSessions/')) await createAdminSessionStore({ database }).get(selected.id);
      if (entry.key.startsWith('fs/discord_membership_verifications/') || entry.key.startsWith('fs/youtube_membership_verifications/')) {
        const [, collection, uid] = entry.key.split('/'), provider = collection.startsWith('discord') ? 'discord' : 'youtube';
        const path = `users/${encodeKey(uid)}/verification/${provider}`;
        const native = { ...entry.value, completed: entry.value.consumed, profileGeneration: 0 };
        validateVerificationState(native, provider);
        const result = await database.ref(path).transaction(current => current === null || fingerprint(current) === fingerprint(native) ? native : undefined, undefined, false);
        if (!result.committed) throw fail('MIGRATION_TARGET_CONFLICT');
      }
      if (entry.key.startsWith('fs/cardApiKeys/')) {
        for (const origin of entry.value.origins) await database.ref(`apiAccess/origins/${hash(origin)}/${entry.key.split('/').at(-1)}`).set(true);
      }
      if (!previous) await put(mirror, entry.key, entry);
      return { digest: content(entry) };
    },
    async snapshot() {
      await initCsv();
      const result = new Map();
      // 명시적으로 복사한 항목을 현행 프로필·인벤토리 reader로 확인한다.
      for (const entry of source.values()) {
        const saved = await readMirror(entry.key); if (!saved) continue;
        const selected = target(entry.key, entry.value);
        if (selected) {
          const record = entry.key.startsWith('inventory/') ? await inventory.read(selected.id) : await selected.store.read(selected.id);
          result.set(entry.key, record.exists ? { key: entry.key, exists: true, token: String(record.revision), value: entry.key.startsWith('inventory/') ? record.value : selected.decode ? selected.decode(record.value) : record.value } : { ...empty(entry.key), token: String(record.revision) });
        } else result.set(entry.key, { ...saved, token: 'mirror' });
      }
      // 전환 후 신규·삭제·사용량·회원 목록 변경도 역변환한다.
      async function rows(root) {
        const rows = []; let cursor;
        for (;;) { let query = database.ref(root).orderByKey().limitToFirst(25); if (cursor) query = query.startAfter(cursor);
          const snapshot = await query.get(), value = snapshot.val() || {}, keys = Object.keys(value).sort();
          rows.push(...keys); if (keys.length < 25) break; cursor = keys.at(-1); }
        return rows;
      }
      const { decodeKey } = require('../../functions/services/user-storage/codec');
      for (const encoded of await rows('customClaimsSync')) {
        const lock = await store('customClaimsSync').read(decodeKey(encoded));
        if (lock.exists && lock.value.state !== 'idle') throw fail('MIGRATION_AUTH_WRITE_UNRESOLVED');
      }
      for (const root of ['users', 'inventories', 'adminSessions', 'apiAccess/keys']) for (const encoded of await rows(root)) {
        const id = decodeKey(encoded);
        if (root === 'users') {
          const record = await store('users', 'profile', createProfilePayloadCodec()).read(id), key = `fs/users/${id}`;
          result.set(key, record.exists ? { key, exists: true, token: String(record.revision), value: record.value } : { ...empty(key), token: String(record.revision) });
          const verification = (await database.ref(`users/${encoded}/verification`).get()).val() || {};
          for (const [provider, value] of Object.entries(verification)) {
            const { completed, profileGeneration, ...legacy } = value, key = `fs/${provider === 'discord' ? 'discord' : 'youtube'}_membership_verifications/${id}`;
            result.set(key, { key, exists: true, token: fingerprint(value), value: legacy });
          }
        } else if (root === 'inventories') {
          const record = await inventory.read(id), key = `inventory/${id}`;
          result.set(key, record.exists ? { key, exists: true, token: String(record.revision), value: record.value } : { ...empty(key), token: String(record.revision) });
        } else if (root === 'adminSessions') {
          const record = await store('adminSessions').read(id), key = `fs/AdminWebSessions/${id}`;
          result.set(key, record.exists ? { key, exists: true, token: String(record.revision), value: record.value } : { ...empty(key), token: String(record.revision) });
        } else {
          const record = await store('apiAccess/keys').read(id), key = `fs/cardApiKeys/${id}`, usageKey = `fs/cardApiUsage/${id}`;
          result.set(key, record.exists ? { key, exists: true, token: String(record.revision), value: record.value.policy } : empty(key));
          result.set(usageKey, record.exists && record.value.usage ? { key: usageKey, exists: true, token: String(record.revision), value: record.value.usage } : empty(usageKey));
        }
      }
      const origins = {}; for (const [key, item] of result) if (key.startsWith('fs/cardApiKeys/') && item.exists && item.value.enabled) origins[key.split('/').at(-1)] = item.value.origins;
      const corsKey = 'fs/cardApiConfig/cors', originalCors = source.get(corsKey);
      if (originalCors || Object.keys(origins).length) result.set(corsKey, { key: corsKey, exists: true, token: fingerprint(origins), value: { ...(originalCors?.value || {}), keyOrigins: origins } });
      const projection = await store('migrationProjection').read('csv');
      const csv = createMembershipCsvStore({ database }), active = await csv.read();
      for (const item of source.values()) if (/^fs\/membership_csv_imports\/[a-f0-9]{32}$/.test(item.key)) {
        const record = await csv.status(item.key.split('/').at(-1));
        if (record) result.set(item.key, { key: item.key, exists: true, token: fingerprint(record), value: { ...item.value, status: record.status,
          ...(record.result ? { result: record.result } : {}) } });
      }
      if (active.members.length && active.revision !== projection.value.activeId) {
        const key = 'fs/membership_csv_state/current'; result.set(key, { key, exists: true, token: active.revision, value: { revision: active.revision, count: active.members.length, updatedAt: active.updatedAt } });
      }
      const control = await store('membershipCsv/control').read('current');
      const operations = new Set([...Object.keys(control.value?.operations || {}),
        ...await rows('membershipCsv/operations').then(ids => ids.map(decodeKey)), ...await rows('membershipCsv/candidates').then(ids => ids.map(decodeKey))]);
      for (const id of operations) {
        // 구형 명단용 합성 포인터는 이전 원본의 새 작업으로 만들지 않는다.
        if (id === projection.value.activeId && !source.has(`fs/membership_csv_imports/${id}`)) continue;
        if (source.has(`fs/membership_csv_imports/${id}`)) continue;
        const record = await csv.status(id), metaKey = `fs/membership_csv_imports/${id}`;
        if (!record) throw fail('MIGRATION_ORPHAN_CSV_CANDIDATE');
        result.set(metaKey, { key: metaKey, exists: true, token: active.revision, value: { binding: record.binding, actor: record.actor, status: record.status, startedAt: record.startedAt, result: record.result } });
        if (!record.result) delete result.get(metaKey).value.result;
        const candidate = await store('membershipCsv/candidates').read(id);
        for (const member of candidate.value?.members || []) { const key = `${metaKey}/members/${member.channelId}`; result.set(key, { key, exists: true, token: fingerprint(candidate.value), value: member }); }
      }
      return [...result.values()].sort((a, b) => a.key.localeCompare(b.key));
    },
  };
}
module.exports = { createLegacy, createDestination, COLLECTIONS, checkKey };
