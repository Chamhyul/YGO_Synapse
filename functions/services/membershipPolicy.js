// 저장된 외부 회원 원본과 현재 운영 계정 권한을 분리한다.
function resolveAccountRole(claims = {}) {
  return claims.role === 'owner' ? 'owner' : claims.role === 'admin' || claims.admin === true ? 'admin' : 'none';
}
function normalizeSourceMembership(source) {
  if (!source || typeof source !== 'object') return { status: 'none', type: 'none', levelName: '일반' };
  const provider = source.type === 'csv' ? 'youtube' : source.type === 'discord' ? 'discord' : null;
  if (!provider || source.verificationVersion !== 2 || source.verificationProvider !== provider) {
    return { status: 'none', type: provider ? source.type : 'none', levelName: '일반', verificationRequired: !!provider };
  }
  return { ...source, status: source.status === 'active' ? 'active' : 'none',
    levelName: source.status === 'active' ? source.levelName || (provider === 'youtube' ? '유튜브 멤버십' : '디스코드 멤버십') : '일반' };
}
function resolveEffectiveMembership(accountRole, source) {
  if (!['owner', 'admin', 'none'].includes(accountRole)) throw new Error('현재 계정 권한 확인이 필요합니다.');
  const external = normalizeSourceMembership(source);
  if (accountRole === 'owner' || accountRole === 'admin') return {
    status: 'active', type: 'account', levelName: accountRole === 'owner' ? '소유자' : '관리자', accountRole
  };
  return external;
}
module.exports = { resolveAccountRole, normalizeSourceMembership, resolveEffectiveMembership };
