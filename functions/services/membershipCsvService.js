const { createHash } = require('node:crypto');
const MAX_BYTES = 1024 * 1024;
const MAX_MEMBERS = 5000;
const PENDING_MS = 2 * 60 * 1000;
const CHANNEL = /^UC[A-Za-z0-9_-]{22}$/;
const OPERATION = /^[a-f0-9]{32}$/;
const failure = (status, code, message) => Object.assign(new Error(message), { status, code });
const digest = value => createHash('sha256').update(value).digest('hex');

function membershipCsvValidateMembers(input) {
  if (!Array.isArray(input) || !input.length || input.length > MAX_MEMBERS) {
    throw failure(400, 'MEMBERSHIP_CSV_INVALID', `회원 목록은 1명 이상 ${MAX_MEMBERS}명 이하여야 합니다.`);
  }
  const seen = new Set();
  return input.map((item, index) => {
    const row = index + 2;
    if (!item || typeof item.channelId !== 'string' || !CHANNEL.test(item.channelId) || typeof item.memberName !== 'string'
        || !item.memberName.trim() || item.memberName.length > 300 || typeof item.levelName !== 'string'
        || !item.levelName.trim() || item.levelName.length > 200) {
      throw failure(400, 'MEMBERSHIP_CSV_INVALID', `${row}행의 회원·채널·현재 등급을 확인해 주세요.`);
    }
    if (seen.has(item.channelId)) throw failure(400, 'MEMBERSHIP_CSV_INVALID', `${row}행에 중복 채널이 있습니다.`);
    seen.add(item.channelId);
    return { channelId: item.channelId, memberName: item.memberName.trim(), levelName: item.levelName.trim() };
  }).sort((a, b) => a.channelId.localeCompare(b.channelId));
}

// 인용 셀 안의 쉼표·개행·큰따옴표를 보존한다. 잘못된 행을 건너뛰지 않는다.
function membershipCsvParseMembers(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_BYTES || text.includes('\uFFFD')) {
    throw failure(400, 'MEMBERSHIP_CSV_INVALID', '1MB 이하의 UTF-8 CSV 파일을 선택해 주세요.');
  }
  text = text.replace(/^\uFEFF/, '');
  const rows = []; let row = [], cell = '', quoted = false, closed = false;
  const invalid = () => { throw failure(400, 'MEMBERSHIP_CSV_INVALID', 'CSV의 큰따옴표 또는 열 구성이 올바르지 않습니다.'); };
  const finishCell = () => { row.push(cell.trim()); cell = ''; closed = false; };
  const finishRow = () => { finishCell(); if (row.some(value => value !== '')) rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else cell += c;
    } else if (c === '"') {
      if (cell || closed) invalid(); quoted = true;
    } else if (c === ',') finishCell();
    else if (c === '\n' || c === '\r') { finishRow(); if (c === '\r' && text[i + 1] === '\n') i++; }
    else { if (closed) invalid(); cell += c; }
  }
  if (quoted) invalid();
  finishRow();
  const header = rows.shift() || [];
  const required = ['회원', '프로필에 연결', '현재 등급'];
  if (new Set(header).size !== header.length || required.some(name => !header.includes(name))) {
    throw failure(400, 'MEMBERSHIP_CSV_INVALID', '회원·프로필에 연결·현재 등급 열이 필요하며, 중복된 열 이름은 사용할 수 없습니다.');
  }
  const [nameIndex, urlIndex, levelIndex] = required.map(name => header.indexOf(name));
  return membershipCsvValidateMembers(rows.map((values, index) => {
    if (values.length !== header.length) throw failure(400, 'MEMBERSHIP_CSV_INVALID', `${index + 2}행의 열 수가 맞지 않습니다.`);
    let url;
    try { url = new URL(values[urlIndex]); } catch { /* 아래에서 같은 오류로 처리한다. */ }
    if (!url || url.protocol !== 'https:' || !['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname)
        || url.username || url.password || url.port || url.search || url.hash || !/^\/channel\/UC[A-Za-z0-9_-]{22}\/?$/.test(url.pathname)) {
      throw failure(400, 'MEMBERSHIP_CSV_INVALID', `${index + 2}행의 YouTube 채널 주소를 확인해 주세요.`);
    }
    return { channelId: url.pathname.split('/')[2], memberName: values[nameIndex], levelName: values[levelIndex] };
  }));
}
function summarize(members) {
  const counts = new Map();
  for (const item of members) counts.set(item.levelName, (counts.get(item.levelName) || 0) + 1);
  return { count: members.length, tiers: [...counts].map(([levelName, count]) => ({ levelName, count })) };
}
function createFirestoreMembershipCsvStore(db) {
  const current = db.collection('membership_csv_state').doc('current');
  const operation = id => db.collection('membership_csv_imports').doc(id);
  async function active() {
    const snap = await current.get(); const state = snap.exists ? snap.data() : null;
    if (state && (!OPERATION.test(state.revision) || !Number.isInteger(state.count) || state.count < 1)) {
      throw failure(503, 'MEMBERSHIP_CSV_UNAVAILABLE', '현재 회원 목록을 확인하지 못했습니다.');
    }
    return state;
  }
  return {
    async read() {
      const state = await active();
      const ref = state ? operation(state.revision).collection('members') : db.collection('membership_csv_users');
      const snap = await ref.get(); const members = snap.docs.map(doc => ({ ...doc.data(), channelId: doc.id }));
      if (state && members.length !== state.count) throw failure(503, 'MEMBERSHIP_CSV_UNAVAILABLE', '현재 회원 목록을 확인하지 못했습니다.');
      const legacyRevision = 'legacy-' + digest(JSON.stringify(members.sort((a,b) => a.channelId.localeCompare(b.channelId))));
      return { members, revision: state ? state.revision : legacyRevision, updatedAt: state?.updatedAt || null };
    },
    async readMember(channelId) {
      const state = await active();
      if (state) {
        const meta = await operation(state.revision).get();
        if (meta.data()?.status !== 'completed') throw failure(503, 'MEMBERSHIP_CSV_UNAVAILABLE', '회원 목록을 확인하지 못했습니다.');
      }
      const ref = state ? operation(state.revision).collection('members') : db.collection('membership_csv_users');
      return (await ref.doc(channelId).get()).data() || null;
    },
    async status(id) { return (await operation(id).get()).data() || null; },
    async begin(id, binding, revision, actor, startedAt) {
      return db.runTransaction(async tx => {
        const ref = operation(id), previous = (await tx.get(ref)).data();
        if (previous) {
          if (previous.binding !== binding) throw failure(409, 'MEMBERSHIP_CSV_CONFLICT', '같은 작업 번호로 다른 목록을 적용할 수 없습니다.');
          return previous;
        }
        const state = (await tx.get(current)).data();
        if (state && state.revision !== revision) throw failure(409, 'MEMBERSHIP_CSV_CONFLICT', '회원 목록이 변경되었습니다. 파일 내용을 다시 확인해 주세요.');
        tx.set(ref, { binding, actor, status: 'pending', startedAt });
        return null;
      });
    },
    async stage(id, members) {
      for (let i = 0; i < members.length; i += 450) {
        const batch = db.batch();
        for (const item of members.slice(i, i + 450)) batch.set(operation(id).collection('members').doc(item.channelId), item);
        await batch.commit();
      }
    },
    async commit(id, revision, result) {
      return db.runTransaction(async tx => {
        const state = (await tx.get(current)).data(), ref = operation(id), record = (await tx.get(ref)).data();
        if (record?.status === 'completed') return record.result;
        if (record?.status !== 'pending') throw failure(409, 'MEMBERSHIP_CSV_CONFLICT', '목록 적용 상태가 변경되었습니다.');
        if (state && state.revision !== revision) throw failure(409, 'MEMBERSHIP_CSV_CONFLICT', '회원 목록이 변경되었습니다. 파일 내용을 다시 확인해 주세요.');
        tx.set(current, { revision: id, count: result.count, updatedAt: result.updatedAt });
        tx.update(ref, { status: 'completed', result });
        return result;
      });
    },
    async fail(id) {
      return db.runTransaction(async tx => {
        const ref = operation(id), record = (await tx.get(ref)).data();
        if (record?.status === 'completed') return record.result;
        if (record?.status === 'pending') tx.update(ref, { status: 'failed' });
        return null;
      });
    },
    async expire(id, time) {
      return db.runTransaction(async tx => {
        const ref = operation(id), record = (await tx.get(ref)).data();
        // 만료 처리와 전환은 같은 작업 문서를 검사하여 늦은 저장을 차단한다.
        if (record?.status === 'pending' && record.startedAt + PENDING_MS <= time) {
          tx.update(ref, { status: 'failed' }); return { ...record, status: 'failed' };
        }
        return record;
      });
    }
  };
}
function createMembershipCsvService({ store, now = Date.now }) {
  const parse = body => body && typeof body === 'object' && !Array.isArray(body) && typeof body.csvText === 'string'
    ? membershipCsvParseMembers(body.csvText) : membershipCsvValidateMembers(body?.members);
  const checkId = id => { if (typeof id !== 'string' || !OPERATION.test(id)) throw failure(400, 'MEMBERSHIP_CSV_INVALID', '작업 번호가 올바르지 않습니다.'); };
  const binding = (actor, body, members) => digest(JSON.stringify([actor, body.revision, digest(JSON.stringify(members))]));
  async function preview(body) {
    const members = parse(body), previous = await store.read();
    const old = new Map(previous.members.map(item => [item.channelId, item]));
    const next = new Set(members.map(item => item.channelId));
    return { ...summarize(members), revision: previous.revision, fingerprint: digest(JSON.stringify(members)),
      previousCount: old.size, added: members.filter(item => !old.has(item.channelId)).length,
      removed: previous.members.filter(item => !next.has(item.channelId)).length,
      changed: members.filter(item => old.has(item.channelId) && old.get(item.channelId).levelName !== item.levelName).length };
  }
  return {
    async summary() { const state = await store.read(); return { ...summarize(state.members), revision: state.revision, updatedAt: state.updatedAt }; },
    preview,
    async status(body, actor) {
      checkId(body?.operationId);
      let record = await store.status(body.operationId);
      // 작업 번호만으로 다른 관리자의 결과를 조회할 수 없다.
      if (record && record.actor !== actor) throw failure(403, 'MEMBERSHIP_CSV_FORBIDDEN', '이 작업의 결과를 확인할 수 없습니다.');
      if (record?.status === 'pending') record = await store.expire(body.operationId, now());
      return { status: record?.status || 'unknown', ...(record?.status === 'completed' ? { result: record.result } : {}) };
    },
    async apply(body, actor) {
      checkId(body?.operationId);
      if (typeof actor !== 'string' || !actor) throw failure(403, 'MEMBERSHIP_CSV_FORBIDDEN', '관리자 인증이 필요합니다.');
      const members = parse(body), fingerprint = digest(JSON.stringify(members));
      if (fingerprint !== body.fingerprint || typeof body.revision !== 'string') throw failure(400, 'MEMBERSHIP_CSV_INVALID', '파일 내용을 먼저 확인해 주세요.');
      const bound = binding(actor, body, members), record = await store.status(body.operationId);
      if (record) {
        if (record.binding !== bound) throw failure(409, 'MEMBERSHIP_CSV_CONFLICT', '작업 번호가 이미 사용되었습니다. 파일 내용을 다시 확인해 주세요.');
        if (record.status === 'completed') return record.result;
        throw failure(409, 'MEMBERSHIP_CSV_PROCESSING', record.status === 'pending' ? '아직 적용 중입니다. 적용 결과를 확인해 주세요.' : '적용하지 못했습니다. 파일 내용을 다시 확인해 주세요.');
      }
      const previous = await store.read();
      if (previous.revision !== body.revision) throw failure(409, 'MEMBERSHIP_CSV_CONFLICT', '회원 목록이 변경되었습니다. 파일 내용을 다시 확인해 주세요.');
      const started = await store.begin(body.operationId, bound, body.revision, actor, now());
      if (started) {
        if (started.status === 'completed') return started.result;
        throw failure(409, 'MEMBERSHIP_CSV_PROCESSING', '이미 요청한 작업입니다. 적용 결과를 확인해 주세요.');
      }
      try {
        await store.stage(body.operationId, members);
        return await store.commit(body.operationId, body.revision, { ...summarize(members), revision: body.operationId, updatedAt: now() });
      } catch (error) {
        // 응답만 유실된 경우 완료 기록을 확인하여 중복 적용을 피한다.
        const completed = await store.fail(body.operationId);
        if (completed) return completed;
        throw error;
      }
    }
  };
}
module.exports = { membershipCsvParseMembers, membershipCsvValidateMembers, createMembershipCsvService,
  createFirestoreMembershipCsvStore, MAX_BYTES, MAX_MEMBERS };
