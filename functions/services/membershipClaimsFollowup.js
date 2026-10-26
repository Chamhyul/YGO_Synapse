'use strict';
const { decodeKey } = require('./user-storage/codec');
const { decodeRecord } = require('./user-storage/recordStore');
const { createProfilePayloadCodec } = require('./user-storage/profileCodec');
const { membershipVersion, membershipPermissionVersion } = require('./user-storage/membershipStore');
const { measure, mark } = require('./membershipWorkerTiming');
const codec = createProfilePayloadCodec();
const failure = () => Object.assign(new Error('멤버십 후속 동기화가 완료되지 않았습니다.'), { code: 'MEMBERSHIP_FOLLOWUP_PENDING' });

function sourceVersion(raw, path) {
  const record = decodeRecord(raw, { path, payloadCodec: codec });
  return membershipVersion(record.exists ? record.value?.settings?.membership : undefined);
}
function sourceMembership(raw, path) {
  const record = decodeRecord(raw, { path, payloadCodec: codec });
  return record.exists ? record.value?.settings?.membership : undefined;
}

// 저장 이벤트는 전달 신호일 뿐이다. 과거 이벤트 payload를 Auth에 쓰지 않고,
// 현재 공통 writer 원본·계정·잠금·영수증을 다시 대조하는 기존 동기화를 사용한다.
function createMembershipClaimsFollowup({ select, sync, wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  emit = value => console.log(JSON.stringify(value)) }) {
  return async event => {
    const started = Date.now(), key = event.params?.userKey;
    const uid = decodeKey(key);
    if (!uid || uid.length > 128 || uid.includes('/')) throw failure();
    const path = `users/${key}/profile`;
    const versions = measure('worker.event_decode', () => {
      const before = sourceMembership(event.data.before.val(), path), after = sourceMembership(event.data.after.val(), path);
      return { unchanged: membershipVersion(before) === membershipVersion(after),
        permissionChanged: membershipPermissionVersion(before) !== membershipPermissionVersion(after) };
    });
    if (versions.unchanged) { mark('unchanged'); return; }
    const runtime = measure('worker.runtime', select);
    if (!runtime?.storage || runtime.config.mode !== 'production'
        || event.instance !== runtime.config.instanceId || event.location !== runtime.config.location) throw failure();
    // 전환·역전환 중 source를 추측하지 않는다. 현재 route가 accepting인 경우만 실행한다.
    const route = await measure('worker.route', () => runtime.storage.writerTransition.route());
    if (route.phase !== 'accepting') throw failure();
    for (let attempt = 0; attempt < 4; attempt++) {
      const result = await measure('worker.sync', () => sync(uid, runtime, { permissionChanged: versions.permissionChanged }));
      if (result?.status === 'synced') {
        mark('synced', attempt + 1);
        emit({ severity: 'INFO', event: 'membership_followup_timing', status: 'synced',
          attempts: attempt + 1, totalMs: Date.now() - started });
        return;
      }
      // 획득 전 경합과 미확정 쓰기 모두 기존 잠금 판정에 따른다.
      // 제공자 OAuth·nonce 소비는 재실행하지 않는다.
      if (attempt < 3) await measure('worker.retry_wait', () => wait(250 * 2 ** attempt));
    }
    mark('pending', 4);
    emit({ severity: 'WARNING', event: 'membership_followup_timing', status: 'pending', totalMs: Date.now() - started });
    throw failure(); // Eventarc 영속 배달로 재시도하며 HTTP 응답 뒤 실행에 의존하지 않는다.
  };
}
module.exports = { createMembershipClaimsFollowup, sourceVersion };
