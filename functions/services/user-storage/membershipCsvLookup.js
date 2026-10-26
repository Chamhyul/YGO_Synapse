'use strict';
const { createHash } = require('node:crypto');
const { isDeepStrictEqual: equal } = require('node:util');
const { createStorageAccess } = require('./storageAccess');
const { candidateValue } = require('../membershipCsvWriterContract');
const CHANNEL = /^UC[A-Za-z0-9_-]{22}$/;
const fail = () => Object.assign(new Error('회원 조회 자료의 무결성을 확인하지 못했습니다.'), { code: 'CSV_WRITER_LOOKUP_INVALID', status: 503 });
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('base64url');
const memberKey = key => hash(['channel', key]);
const leaf = (key, value) => hash(['member', key, value.levelName]);
function buildLookup(members) {
  if (!Array.isArray(members) || !members.length || members.length > 5000) throw fail();
  const entries = {}, digests = new Map();
  for (const member of members) {
    if (!CHANNEL.test(member.channelId) || typeof member.levelName !== 'string' || !member.levelName || member.levelName.length > 200
        || Object.hasOwn(entries, member.channelId)) throw fail();
    entries[member.channelId] = { levelName: member.levelName };
    digests.set(memberKey(member.channelId), leaf(member.channelId, member));
  }
  return { count: members.length, entries, digests };
}
function verifyEntry(key, value, expected) {
  if (!CHANNEL.test(key)) throw fail();
  const wanted = expected.digests.get(memberKey(key));
  if (value === null) { if (wanted !== undefined) throw fail(); return null; }
  if (!value || Object.keys(value).join(',') !== 'levelName' || typeof value.levelName !== 'string'
      || !value.levelName || value.levelName.length > 200 || wanted !== leaf(key, value)) throw fail();
  return { channelId: key, levelName: value.levelName };
}
function projection(source, built) {
  return { head: { format: 1, fingerprint: source.fingerprint, count: built.count }, entries: built.entries };
}
function createMembershipCsvLookup({ database, timeoutMs, onAmbiguousWrite }) {
  const access = createStorageAccess({ database, timeoutMs, onAmbiguousWrite }), manifests = new Map();
  const keyFor = pointer => {
    if (!pointer || !/^[a-f0-9]{32}$/.test(pointer.revision) || !/^[a-f0-9]{64}$/.test(pointer.fingerprint)
        || !Number.isInteger(pointer.count) || pointer.count < 1 || pointer.count > 5000) throw fail();
    return `${pointer.revision}/${pointer.fingerprint}`;
  };
  const refFor = pointer => database.ref(`membershipCsvLookup/${keyFor(pointer)}`);
  function keep(key, value) { manifests.delete(key); manifests.set(key, value); if (manifests.size > 4) manifests.delete(manifests.keys().next().value); }
  const validatedSource = async (pointer, readSource) => {
    const source = candidateValue(await readSource());
    if (source.fingerprint !== pointer.fingerprint || source.members.length !== pointer.count) throw fail();
    return source;
  };
  async function expectedFor(pointer, readSource) {
    const key = keyFor(pointer);
    if (manifests.has(key)) return manifests.get(key);
    const pending = (async () => {
      const built = buildLookup((await validatedSource(pointer, readSource)).members);
      return { count: built.count, digests: built.digests };
    })();
    keep(key, pending);
    try { return await pending; }
    catch (error) { if (manifests.get(key) === pending) manifests.delete(key); throw error; }
  }
  async function install(pointer, source) {
    source = await validatedSource(pointer, async () => source);
    const key = keyFor(pointer), built = buildLookup(source.members), value = projection(source, built);
    let conflict;
    const saved = await access.guarded(refFor(pointer).transaction(current => {
      conflict = false;
      if (current !== null && !equal(current, value)) { conflict = true; return; }
      return value;
    }, undefined, false), true);
    if (conflict || !saved.committed || !equal(saved.snapshot.val(), value)) throw fail();
    keep(key, { count: built.count, digests: built.digests });
    return { count: built.count, indexBytes: Buffer.byteLength(JSON.stringify(value)) };
  }
  async function read(pointer, channelId, readSource) {
    if (!CHANNEL.test(channelId)) throw fail();
    const key = keyFor(pointer), base = refFor(pointer);
    const fallback = async () => {
      const source = await validatedSource(pointer, readSource), member = source.members.find(m => m.channelId === channelId);
      return member ? { channelId, levelName: member.levelName } : null;
    };
    let expected;
    if (manifests.has(key)) expected = await manifests.get(key);
    else {
      const header = await access.guarded(base.child('head').get(), false);
      if (!header.exists()) return fallback(); // 구형 자료는 인증 조회에서 쓰지 않는다.
      const head = header.val();
      if (!head || Object.keys(head).sort().join(',') !== 'count,fingerprint,format' || head.format !== 1
          || head.count !== pointer.count || head.fingerprint !== pointer.fingerprint) throw fail();
      expected = await expectedFor(pointer, readSource);
    }
    if (expected.count !== pointer.count) throw fail();
    // 캐시에는 회원 이름/채널/등급/판정이 아닌 원본 버전의 검증 지문만 둔다.
    // 활성 버전·계정 자격·실제 레코드는 요청마다 서버에서 조회한다.
    const point = await access.guarded(base.child(`entries/${channelId}`).get(), false);
    if (!point.exists() && expected.digests.has(memberKey(channelId))
        && !(await access.guarded(base.child('head').get(), false)).exists()) return fallback();
    return verifyEntry(channelId, point.val(), expected);
  }
  return { install, read };
}
module.exports = { buildLookup, verifyEntry, projection, createMembershipCsvLookup };
