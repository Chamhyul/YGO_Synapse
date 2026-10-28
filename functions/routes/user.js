const { onRequest: firebaseOnRequest } = require("firebase-functions/v2/https");
const { withPublicReadRequest, isLocal } = require("../services/publicReadTransport");
const { withUserStorageRequestGuard } = require('../services/userStorageRequestGuard');
const { measure, withLoginRequestTiming } = require('../services/inventoryRequestTiming');
const onRequest = (options, handler, storageOptions, timingOperation) => {
  const guarded = withUserStorageRequestGuard(withPublicReadRequest(handler), storageOptions);
  const result = (req, res) => timingOperation === 'getUserData' && req.method === 'POST'
    && req.body?.loginMembershipResult === true && !req.body?.membershipPrepare && !req.body?.membershipClaimsOnly
    && !req.body?.membershipClaimsReadOnly
    ? require('../services/loginMembershipResult').withLoginMembershipResult(req, res, response => guarded(req, response))
    : guarded(req, res);
  return firebaseOnRequest(options, timingOperation ? withLoginRequestTiming(timingOperation, result) : result);
};
const { getUserProfileRepository } = require('../services/userProfileRepository');
const { setCors, verifyRegisteredUser, verifyAppCheck } = require("../utils/auth");
const { deleteInventory } = require("../utils/inventoryStorage");


exports.clearUserData = onRequest({ invoker: "public" }, async (req, res) => {
  setCors(res, req);
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (!(await verifyAppCheck(req, res))) return;

  const uid = await verifyRegisteredUser(req, res);
  if (!uid) return;
  
  try {
    // [Storage 전환] 인벤토리 파일 삭제로 초기화
    await deleteInventory(uid);
    return res.json({ success: true, message: "모든 데이터가 성공적으로 초기화되었습니다." });
  } catch (e) {
    console.error("clearUserData error:", e);
    return res.status(500).json({ success: false, message: e.toString() });
  }
});

exports.getUserData = onRequest({ invoker: "public", memory: "256MiB" }, async (req, res) => {
  setCors(res, req);
  res.set("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).send("");

  // warmup=true: 초기 로딩 시 컨테이너 사전 부팅(Hot-Start)을 위한 선제 핑 — 즉시 반환
  const preparing = req.body?.membershipPrepare === true;
  if (!preparing && (req.query.warmup === 'true' || (req.body && req.body.warmup === 'true'))) {
    return res.json({ success: true, message: "warmed up" });
  }

  if (preparing && !(await verifyAppCheck(req, res))) return;
  let checkedClaims;
  const claimsOnly = !preparing && req.body?.membershipClaimsOnly === true;
  const accountWindow = claimsOnly && !isLocal() && process.env.USER_STORAGE_BACKEND === 'rtdb'
    ? async ({ uid, auth, read }) => {
      const checked = await require('../services/membershipClaims').readMembershipClaimsStatusWithAccount(uid,
        { auth, readAccount: read });
      checkedClaims = checked.membershipClaims;
      return checked.account;
    } : !preparing && !claimsOnly && !req.body?.membershipClaimsReadOnly && req.body?.loginMembershipResult === true
      && !isLocal() && process.env.USER_STORAGE_BACKEND === 'rtdb'
      ? value => require('../services/loginMembershipResult').prepareLoginAccount(value) : undefined;
  const uid = await verifyRegisteredUser(req, res, { includeAccountRole: true, accountWindow });
  if (!uid) return;

  try {
    if (preparing) return measure('membership.prepare', () =>
      require('../services/membershipReadiness').respondMembershipReadiness(req, res, 'getUserData'));
    // 명시적 완료 확인만 경량 응답을 선택한다. 기존 전체 응답 계약은 유지한다.
    if (req.body?.membershipClaimsOnly === true) {
      const membershipClaims = checkedClaims || await require('../services/membershipClaims').readMembershipClaimsStatus(uid);
      return res.json({ success: true, membershipClaims });
    }
    // 인증된 전체 조회 계약을 유지하고 명시적인 재인증 후 조회만 claims 쓰기를 분리한다.
    const data = await require('../services/loginUserData').readLoginUserData(req, uid, {
      membershipClaimsReadOnly: req.body?.membershipClaimsReadOnly === true,
      inventoryConditional: req.body?.inventoryConditional === true,
      inventoryToken: req.body?.inventoryToken,
      ...(req.body?.loginMembershipResult === true && !req.body?.membershipClaimsReadOnly
        ? { readMembershipClaims: require('../services/loginMembershipResult').readLoginClaims } : {}),
    });
    return measure('login.response', () => res.json(data));
  } catch (e) {
    if (e.code === 'ACCOUNT_ROLE_UNAVAILABLE') return res.status(503).json({ success: false, code: e.code, message: e.message });
    console.error("getUserData error:", e);
    return res.status(500).json({ success: false, message: e.toString() });
  }
}, { allowWarmup: true }, 'getUserData');

exports.updateUserSettings = onRequest({ invoker: "public" }, async (req, res) => {
  setCors(res, req);
  if (req.method === "OPTIONS") return res.status(204).send("");

  const uid = await verifyRegisteredUser(req, res);
  if (!uid) return;

  const { settings } = req.body;
  if (!settings || typeof settings !== 'object') {
    return res.status(400).json({ success: false, message: "설정 데이터 형식이 올바르지 않습니다." });
  }

  // 허용된 설정 키만 통과 (임의 필드 주입 방지)
  const ALLOWED_SETTINGS_KEYS = ['theme', 'isDetailMode', 'hideMembershipVerify', 'readNotices', 'onboarding'];
  const filteredSettings = Object.fromEntries(
    Object.entries(settings).filter(([key]) => ALLOWED_SETTINGS_KEYS.includes(key))
  );
  if (Object.keys(filteredSettings).length === 0) {
    return res.status(400).json({ success: false, message: "유효한 설정 필드가 없습니다." });
  }

  try {
    await getUserProfileRepository().updateSettings(uid, filteredSettings);

    return res.json({ success: true, message: "설정이 성공적으로 저장되었습니다." });
  } catch (e) {
    console.error("updateUserSettings error:", e);
    return res.status(500).json({ success: false, message: e.toString() });
  }
});

exports.updateNickname = onRequest({ invoker: "public" }, async (req, res) => {
  setCors(res, req);
  if (req.method === "OPTIONS") return res.status(204).send("");
  
  const uid = await verifyRegisteredUser(req, res);
  if (!uid) return;

  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'POST 요청을 사용하세요.' });
  const { nickname } = req.body || {};
  if (!nickname || typeof nickname !== 'string' || nickname.trim().length === 0) {
    return res.status(400).json({ success: false, message: "닉네임을 입력해 주세요." });
  }
  if (nickname.trim().length > 10) {
    return res.status(400).json({ success: false, message: "닉네임은 최대 10자까지 입력할 수 있습니다." });
  }

  try {
    await getUserProfileRepository().updateNickname(uid, nickname.trim());

    return res.json({ success: true, message: "닉네임이 성공적으로 변경되었습니다." });
  } catch (e) {
    console.error("updateNickname error:", e);
    return res.status(500).json({ success: false, message: e.toString() });
  }
});

Object.defineProperty(exports, 'getInitialData', { enumerable: true, get: () => require('./initialData').getInitialData });
