'use strict';
const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { resolveAccountRole, resolveEffectiveMembership } = require('../../functions/services/membershipPolicy');

function sourceMembership(row) {
  if (!row?.provider_account_id || !['discord','youtube'].includes(row.provider)) return undefined;
  return { type:row.provider === 'youtube' ? 'csv' : 'discord', status:row.status,
    levelName:row.level_name || '일반', [row.provider === 'youtube' ? 'userChannelId' : 'discordId']:row.provider_account_id,
    verificationVersion:2, verificationProvider:row.provider };
}
function expectedClaim(source) {
  // Supabase의 검증된 고정 스칼라 필드만 기존 claims writer의 권한 버전과 대조한다.
  // 저장소 codec/RTDB 클라이언트는 가져오지 않는다. writer와의 일치 여부는 계약 테스트로 검증한다.
  let version = '0';
  if (source) {
    const encoded = { t:'object', p:'object' };
    for (const [key,value] of Object.entries(source)) encoded['k'+Buffer.from(key).toString('base64url')] = value;
    const canonical = value => value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key,canonical(value[key])])) : value;
    const original = createHash('sha256').update(JSON.stringify(canonical({version:1,value:encoded}))).digest('hex');
    version = createHash('sha256').update('ygo-membership-permission-v1\0').update(original).digest('hex');
  }
  return { v:1, active:source?.status === 'active', provider:source?.verificationProvider || 'none', version };
}
function accountView(account, row, { demo = false } = {}) {
  const source = sourceMembership(row), role = resolveAccountRole(account.customClaims);
  const membership = resolveEffectiveMembership(role, source);
  if (!row && role === 'none') membership.status = 'unknown';
  const desired = expectedClaim(source);
  const synced = isDeepStrictEqual(account.customClaims?.ygoMembership, desired);
  const notRequired = demo || !source && !account.customClaims?.ygoMembership;
  return { accountRole:role, membership, sourceMembership:source ? {
    type:source.type,status:source.status,levelName:source.levelName,
  } : null, isMemberActive:membership.status === 'active',
  membershipClaims:notRequired ? {status:'not_required'} : synced
    ? {status:'synced',version:desired.version,tokenRefreshDeferred:true} : {status:'pending'},
  claimsPending:!notRequired && !synced };
}
module.exports = { accountView, sourceMembership, expectedClaim };
