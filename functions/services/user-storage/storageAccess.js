'use strict';

const DEFAULT_TIMEOUT_MS = 10000;
const ambiguousDatabases = new WeakSet();
const failure = (code, message) => Object.assign(new Error(message), { code });

// 선행 /를 포함한 SDK 절대 경로 한도를 검사한다. 루트 전체 접근은 허용하지 않는다.
function validateStoragePath(path) {
  if (typeof path !== 'string' || Buffer.from(path, 'utf8').toString('utf8') !== path) {
    throw failure('USER_STORAGE_INVALID_PATH', '사용자 저장 경로가 올바르지 않습니다.');
  }
  const normalized = path.startsWith('/') ? path.slice(1) : path;
  const parts = normalized.split('/');
  if (parts.length > 32 || parts.some(part => !part || /[.$#[\]\u0000-\u001f\u007f]/.test(part))
      || Buffer.byteLength(`/${normalized}`, 'utf8') > 768) {
    throw failure('USER_STORAGE_INVALID_PATH', '사용자 저장 경로가 RTDB 형식 또는 전체 경로 한도를 초과합니다.');
  }
  return normalized;
}

// 같은 SDK DB 객체에서 카드 stage와 head CAS가 미확정 쓰기 상태를 공유한다.
function createStorageAccess({ database, timeoutMs = DEFAULT_TIMEOUT_MS, onAmbiguousWrite } = {}) {
  if (!database || !['object', 'function'].includes(typeof database) || typeof database.ref !== 'function'
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1
      || (onAmbiguousWrite !== undefined && typeof onAmbiguousWrite !== 'function')) {
    throw failure('USER_STORAGE_INVALID_CONFIG', '사용자 저장소 설정이 올바르지 않습니다.');
  }
  function ensureUsable() {
    if (ambiguousDatabases.has(database)) {
      throw failure('USER_STORAGE_WRITE_AMBIGUOUS', '이전 저장 결과를 확인해야 합니다. 새 저장소 연결에서 데이터를 대조해 주세요.');
    }
  }

  async function guarded(promise, write = false) {
    ensureUsable();
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!write) { reject(failure('USER_STORAGE_READ_TIMEOUT', '사용자 데이터 조회 시간이 초과되었습니다.')); return; }
        ambiguousDatabases.add(database);
        const error = failure('USER_STORAGE_WRITE_AMBIGUOUS', '저장 승인 응답을 확인하지 못했습니다. 반영 여부를 대조한 뒤 다시 시도해 주세요.');
        // 연결 종료는 이미 제출된 쓰기의 취소/롤백 보장이 아니다. 늦은 성공도 반환하지 않는다.
        if (onAmbiguousWrite) Promise.resolve().then(() => onAmbiguousWrite(error)).catch(() => {});
        reject(error);
      }, timeoutMs);
      // 명시적인 SDK 거부는 그대로 전달하며 시간초과와 달리 연결을 차단하지 않는다.
      Promise.resolve(promise).then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
    });
    ensureUsable();
    return result;
  }

  function reference(path) {
    ensureUsable();
    return database.ref(validateStoragePath(path));
  }

  return {
    ensureUsable,
    guarded,
    async read(path) { return (await guarded(reference(path).get(), false)).val(); },
    async write(path, value) { await guarded(reference(path).set(value), true); },
    async remove(path) { await guarded(reference(path).remove(), true); },
    // 현재/미래 head가 참조하지 않는 고유 노드만 호출자가 지정한다.
    // 늦은 정리가 현재 데이터에 영향을 주지 않으므로 확정된 업무 저장을 미확정으로 바꾸지 않는다.
    async removeUnreferenced(path) {
      try { await guarded(reference(path).remove(), false); }
      catch (error) {
        if (error?.code === 'USER_STORAGE_READ_TIMEOUT') {
          throw failure('USER_STORAGE_CLEANUP_TIMEOUT', '참조되지 않는 저장 노드의 정리 승인 시간이 초과되었습니다.');
        }
        throw error;
      }
    },
  };
}

module.exports = { createStorageAccess, validateStoragePath, DEFAULT_TIMEOUT_MS };
