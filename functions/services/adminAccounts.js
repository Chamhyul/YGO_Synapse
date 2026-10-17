'use strict';
const ACTIONS = new Set(['settingsList', 'settingsLookup', 'settingsSetAdmin']);
const roleOf = claims => claims?.role === 'owner' ? 'owner' : claims?.admin === true || claims?.role === 'admin' ? 'admin' : 'none';
const fail = (status, code, message) => Object.assign(new Error(message), { status, code: 'ADMIN_ACCOUNTS_' + code });
const uidValid = value => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\s/\u0000-\u001f\u007f]/.test(value);
function validateRequest(body) {
  if (!body || !ACTIONS.has(body.action)) throw fail(400,'INVALID','계정 관리 요청을 확인해 주세요.');
  const allowed = body.action === 'settingsList' ? ['action','pageToken'] : body.action === 'settingsLookup' ? ['action','kind','value'] : ['action','targetUid','isAdmin','expectedRole'];
  if (Object.keys(body).some(key=>!allowed.includes(key))) throw fail(400,'INVALID','허용되지 않은 계정 관리 요청입니다.');
  if (body.action === 'settingsList' && body.pageToken !== undefined && (typeof body.pageToken !== 'string' || body.pageToken.length > 4096)) throw fail(400,'INVALID','목록 조회 정보를 확인해 주세요.');
  if (body.action === 'settingsLookup' && (!['uid','email'].includes(body.kind) || typeof body.value !== 'string' || !body.value.trim() || body.value.length > 320 || (body.kind === 'uid' ? !uidValid(body.value.trim()) : !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.value.trim())))) throw fail(400,'INVALID','올바른 UID 또는 이메일을 입력해 주세요.');
  if (body.action === 'settingsSetAdmin' && (!uidValid(body.targetUid) || typeof body.isAdmin !== 'boolean' || !['none','admin'].includes(body.expectedRole))) throw fail(400,'INVALID','대상 계정과 변경할 권한을 확인해 주세요.');
}
const summary = user => ({ uid:user.uid, displayName:user.displayName || '', email:user.email || '', disabled:user.disabled === true, role:roleOf(user.customClaims) });
function roleGuard(expectedRole, granting) {
  return (claims, account) => {
    const current=roleOf(claims);
    if(granting && account?.disabled)throw fail(400,'DISABLED','사용 중지된 계정에는 관리자 권한을 부여할 수 없습니다.');
    if(current==='owner')throw fail(403,'OWNER_PROTECTED','소유자 권한은 이 화면에서 변경할 수 없습니다.');
    // 동일 요청의 재전송은 권한을 반대로 바꾸지 않는다.
    if(current!==expectedRole && current!==(granting?'admin':'none'))throw fail(409,'CONFLICT','권한이 변경되었습니다. 계정을 다시 조회해 주세요.');
  };
}
function createAdminAccounts({auth, updateClaims}) {
  return async (body, callerUid) => {
    const caller=await auth.getUser(callerUid);
    if(caller.disabled || roleOf(caller.customClaims)!=='owner')throw fail(403,'OWNER_REQUIRED','소유자 계정만 관리자 설정을 사용할 수 있습니다.');
    validateRequest(body);
    if(body.action==='settingsList') {
      const page=await auth.listUsers(200, body.pageToken || undefined);
      return {accounts:page.users.filter(user=>roleOf(user.customClaims)!=='none').map(summary),nextPageToken:page.pageToken || null};
    }
    let account;
    try { account=body.action==='settingsLookup' && body.kind==='email' ? await auth.getUserByEmail(body.value.trim()) : await auth.getUser(body.action==='settingsLookup'?body.value.trim():body.targetUid); }
    catch(error){if(error.code==='auth/user-not-found')throw fail(404,'NOT_FOUND','등록된 계정이 없습니다. 봇 계정으로 서비스에 먼저 로그인해 주세요.');throw error;}
    if(body.action==='settingsLookup')return {account:summary(account)};
    if(account.uid===callerUid)throw fail(403,'SELF_PROTECTED','현재 로그인한 계정의 권한은 이 화면에서 변경할 수 없습니다.');
    const guard=roleGuard(body.expectedRole,body.isAdmin);guard(account.customClaims || {}, account);
    if(account.disabled && body.isAdmin)throw fail(400,'DISABLED','사용 중지된 계정에는 관리자 권한을 부여할 수 없습니다.');
    await updateClaims(account.uid,{role:body.isAdmin?'admin':'none',admin:body.isAdmin},guard);
    // 응답이 끊기거나 실제 반영을 읽지 못하면 성공으로 표시하지 않는다.
    const actual=await auth.getUser(account.uid);
    if(roleOf(actual.customClaims)!==(body.isAdmin?'admin':'none'))throw fail(409,'CONFLICT','반영 결과가 변경되었습니다. 계정을 다시 조회해 주세요.');
    return {account:summary(actual)};
  };
}
module.exports={ACTIONS,createAdminAccounts,validateRequest,roleGuard,roleOf};
