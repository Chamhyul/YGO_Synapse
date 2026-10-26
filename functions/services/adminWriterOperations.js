'use strict';
const { randomBytes } = require('node:crypto');
const { accountResource } = require('./user-storage/accountResource');
const { createMembershipCsvService } = require('./membershipCsvService');
const { updateAccountClaims } = require('./membershipClaims');
const { validateCurrentAccount } = require('./requestAccount');
const invalid = () => Object.assign(new Error('격리된 관리자 의존성과 같은 writer run이 필요합니다.'), { code: 'USER_STORAGE_CONFIG_INVALID' });
const roleOf = user => user.customClaims?.role === 'owner' ? 'owner' : user.customClaims?.admin === true || user.customClaims?.role === 'admin' ? 'admin' : null;
function createWriterAdminOperations({ writerBinding, auth, env = process.env, setCors = () => {}, timeoutMs = 10000 } = {}) {
  const resolve = () => require('../config/userProfileWriter').resolveProfileWriterConfig(env);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) throw invalid();
  const initial = JSON.stringify(resolve());
  const check = () => { const config = resolve(); if (JSON.stringify(config) !== initial || config.runId !== writerBinding?.transition?.runId
      || !writerBinding.adminRequests || !writerBinding.notices || !writerBinding.membershipCsv || !auth?.verifyIdToken || !auth?.getUser
      || !require('../config/userStorage').sameConnectionConfig(config, writerBinding.claimsStorage?.config)) throw invalid(); };
  check();
  const requests = writerBinding.adminRequests;
  const csv = createMembershipCsvService({ store: writerBinding.membershipCsv });
  async function readAuth(action) {
    let timer;
    try { return await Promise.race([Promise.resolve().then(action), new Promise((_, reject) => { timer = setTimeout(() => reject(invalid()), timeoutMs); })]); }
    finally { clearTimeout(timer); }
  }
  async function authorize(req, res, target, operation, ownerOnly, identity) {
    const accessOnly = operation === 'checkAdminAccess';
    const header = req.headers?.authorization;
    if (typeof header !== 'string' || !/^Bearer \S+$/.test(header)) { res.status(401).json(accessOnly ? { success: false } : { success: false, code: 'AUTH_INVALID', message: '로그인 정보가 필요합니다.' }); return; }
    if (identity) await requests.reserveAccounts([identity.uid, ...(target ? [target] : [])]);
    let decoded;
    try {
      // 초기 자격을 통과한 요청만 잠금을 예약한다. 기다린 뒤 토큰 만료와
      // 현재 Auth를 다시 확인하며, HTTP 본문/이전 역할을 쓰기 권한으로 재사용하지 않는다.
      decoded = await readAuth(() => auth.verifyIdToken(header.slice(7), false));
      try { accountResource(decoded.uid); } catch (_) { throw Object.assign(Error('invalid identity'), { code: 'AUTH_INVALID' }); }
      if (identity && identity.uid !== decoded.uid) throw Object.assign(Error('identity changed'), { code: 'AUTH_INVALID' });
    } catch (error) {
      if (accessOnly) { res.status(401).json({ success: false }); return; }
      const rejected = ['AUTH_INVALID','auth/argument-error','auth/invalid-argument','auth/invalid-id-token','auth/id-token-expired','auth/id-token-revoked','auth/user-disabled','auth/user-not-found'].includes(error.code);
      res.status(rejected ? 401 : 503).json({ success: false, code: rejected ? 'AUTH_INVALID' : 'AUTH_VERIFICATION_UNAVAILABLE',
        message: rejected ? '로그인 정보가 만료되었거나 유효하지 않습니다.' : '인증 상태를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.' }); return;
    }
    let user;
    try { user = validateCurrentAccount(await readAuth(() => auth.getUser(decoded.uid)), decoded); }
    catch (error) {
      const denied = ['auth/user-disabled', 'auth/user-not-found', 'auth/id-token-revoked'].includes(error.code);
      res.status(denied ? 401 : 503).json(accessOnly ? { success: false } : { success: false,
        ...(denied ? { code: 'AUTH_INVALID', message: '로그인 정보가 만료되었거나 유효하지 않습니다.' }
          : { message: '관리자 권한을 확인할 수 없습니다.' }) }); return;
    }
    if (user.disabled) { res.status(401).json({ success: false }); return; }
    const role = roleOf(user);
    if (!role || ownerOnly && role !== 'owner') { res.status(403).json(accessOnly ? { success: false } : { success: false, message: '이 작업에 필요한 관리자 권한이 없습니다.' }); return; }
    return { uid: decoded.uid, role };
  }
  async function execute(operation, req, res, identity, readOnly = false) {
    if (req.method !== 'POST') return res.status(405).json(operation === 'manageAdminRole' ? { error: 'Method Not Allowed. Use POST.' } : { success: false });
    const body = req.body || {}, modifying = operation === 'manageAdminRole' && ['setAdmin', 'setOwner', 'settingsSetAdmin'].includes(body.action);
    const settingsAction = operation === 'manageAdminRole' && ['settingsList','settingsLookup','settingsSetAdmin'].includes(body.action);
    if(settingsAction)require('./adminAccounts').validateRequest(body);
    const caller = readOnly ? identity : await authorize(req, res, modifying && typeof body.targetUid === 'string' ? body.targetUid : undefined, operation,
      modifying || settingsAction || operation === 'checkAdminAccess' && body.scope === 'settings', identity);
    if (!caller) return;
    if (operation === 'checkAdminAccess') {
      if (body.scope === 'settings' && caller.role !== 'owner') return res.status(403).json({ success: false });
      return res.json({ success: true, role: caller.role });
    }
    if (operation === 'manageNotice') return res.json({ success: true, ...await writerBinding.notices.mutate(body, { requireRevision: false }) });
    if (operation === 'uploadMembershipCsv') {
      const preview = await csv.preview(body);
      return res.json({ success: true, ...await csv.apply({ ...body, ...preview, operationId: body.operationId || randomBytes(16).toString('hex') }, caller.uid) });
    }
    if(settingsAction) {
      const manage=require('./adminAccounts').createAdminAccounts({auth,updateClaims:(uid,patch,validateCurrentClaims)=>updateAccountClaims(uid,patch,{auth,storage:writerBinding.claimsStorage,env,allowEmulator:true,timeoutMs,validateCurrentClaims})});
      return res.json({success:true,...await manage(body,caller.uid)});
    }
    if (body.action === 'list') {
      const adminList = []; let pageToken;
      do {
        const page = await readAuth(() => auth.listUsers(1000, pageToken));
        for (const user of page.users) if (user.customClaims?.admin || ['owner', 'admin'].includes(user.customClaims?.role)) adminList.push({ uid: user.uid, email: user.email || '', displayName: user.displayName || '', role: user.customClaims?.role || 'admin', isAdmin: true });
        pageToken = page.pageToken;
      } while (pageToken);
      return res.json({ success: true, count: adminList.length, adminList });
    }
    if (!modifying) return res.status(400).json({ error: '알 수 없는 action입니다. list | setAdmin | setOwner' });
    if (caller.role !== 'owner') return res.status(403).json({ success: false, error: 'Forbidden: 관리자 권한 부여 및 박탈은 총책임자(owner) 권한만 가능합니다.' });
    if (!body.targetUid) return res.status(400).json({ error: 'targetUid 필드가 필요합니다.' });
    const isAdmin = body.action === 'setOwner' || Boolean(body.isAdmin), role = body.action === 'setOwner' ? 'owner' : isAdmin ? 'admin' : 'none';
    await updateAccountClaims(body.targetUid, { role, admin: isAdmin }, { auth, storage: writerBinding.claimsStorage, env, allowEmulator: true, timeoutMs });
    return res.json({ success: true, action: body.action, targetUid: body.targetUid, role, isAdmin,
      message: isAdmin ? `UID ${body.targetUid}에 ${role} 권한 및 DB Administrator 멤버십이 적용되었습니다.` : `UID ${body.targetUid}의 관리자 권한이 해제되고 DB 멤버십이 일반으로 원복되었습니다.` });
  }
  function handler(operation) {
    return async (req, res) => {
      setCors(res, req); res.set('Cache-Control', 'no-store');
      if (req.method === 'OPTIONS') return res.status(204).send('');
      if (req.method !== 'POST') return res.status(405).json(operation === 'manageAdminRole' ? { error: 'Method Not Allowed. Use POST.' } : { success: false });
      const replies = [], buffered = new Proxy(res, { get(target, property) {
        if (['set', 'status', 'json', 'send'].includes(property)) return (...args) => { replies.push([property, args]); return buffered; };
        const value = target[property]; return typeof value === 'function' ? value.bind(target) : value;
      } });
      try {
        try { check(); } catch (_) { return res.status(503).json({ success: false }); }
        const body = req.body || {}, modifying = operation === 'manageAdminRole' && ['setAdmin', 'setOwner', 'settingsSetAdmin'].includes(body.action);
        const settingsAction = operation === 'manageAdminRole' && ['settingsList','settingsLookup','settingsSetAdmin'].includes(body.action);
        if (settingsAction) require('./adminAccounts').validateRequest(body);
        const identity = await authorize(req, res, undefined, operation,
          modifying || settingsAction || operation === 'checkAdminAccess' && body.scope === 'settings');
        if (!identity) return;
        const readOnly = operation === 'checkAdminAccess' || operation === 'manageAdminRole'
          && ['list', 'settingsList', 'settingsLookup'].includes(body.action);
        if (readOnly) {
          const current = await requests.withReadRequest(req, async () => {
            await execute(operation, req, buffered, identity, true);
            // 오래 걸리는 목록·상세 조회 뒤에도 현재 권한·철회·만료를 재확인한다.
            const count = replies.length;
            const current = await authorize(req, buffered, undefined, operation,
              settingsAction || operation === 'checkAdminAccess' && body.scope === 'settings');
            if (!current) replies.splice(0, count);
            return current;
          });
          if (!current) {
            for (const [method, args] of replies) res[method](...args);
            return res;
          }
          if (current.uid !== identity.uid) return res.status(401).json({ success: false });
          if (operation === 'checkAdminAccess') {
            for (const [method, args] of replies) if (method === 'json' && args[0]?.success) args[0].role = current.role;
          }
        } else await requests.withRequest(req, () => execute(operation, req, buffered, identity));
        for (const [method, args] of replies) res[method](...args);
        return res;
      } catch (error) {
        if(operation === 'manageAdminRole' && error.code?.startsWith('ADMIN_ACCOUNTS_'))return res.status(error.status).json({success:false,code:error.code,message:error.message});
        if (operation === 'manageNotice' && [400, 404, 409].includes(error.status)) return res.status(error.status).json({ success: false, message: error.message });
        if (operation === 'manageNotice') return res.status(503).json({ success: false, message: '공지 작업을 완료할 수 없습니다.' });
        if (operation === 'uploadMembershipCsv') { const expected = error.code?.startsWith('MEMBERSHIP_CSV_'); return res.status(expected ? error.status : 503).json({ success: false, message: expected ? error.message : '멤버십 목록 적용 결과를 확인하지 못했습니다.' }); }
        return res.status(operation === 'manageAdminRole' ? 500 : 503).json({ success: false, ...(operation === 'manageAdminRole' ? { message: '관리자 권한 변경에 실패했습니다.' } : {}) });
      }
    };
  }
  const operations = Object.fromEntries(['checkAdminAccess', 'manageNotice', 'manageAdminRole', 'uploadMembershipCsv'].map(operation => [operation, handler(operation)]));
  Object.defineProperty(operations, 'checkEnvironment', { value: check });
  return operations;
}
module.exports = { createWriterAdminOperations };
