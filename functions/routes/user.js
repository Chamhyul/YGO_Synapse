const { normalizeSourceMembership, resolveEffectiveMembership } = require('../services/membershipPolicy');
const { onRequest: firebaseOnRequest } = require("firebase-functions/v2/https");
const { withPublicReadRequest } = require("../services/publicReadTransport");
const { withUserStorageRequestGuard } = require('../services/userStorageRequestGuard');
const onRequest = (options, handler, storageOptions) => firebaseOnRequest(options,
  withUserStorageRequestGuard(withPublicReadRequest(handler), storageOptions));
const { getUserProfileRepository } = require('../services/userProfileRepository');
const { setCors, verifyRegisteredUser, getVerifiedAccountRole, verifyAppCheck } = require("../utils/auth");
const { downloadInventory, updateInventoryWithRetry, deleteInventory } = require("../utils/inventoryStorage");

const { ensureInventoryV2, inventoryMigrationStatus } = require('../services/inventoryMigrationService');

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
  if (req.method === "OPTIONS") return res.status(204).send("");

  // warmup=true: 초기 로딩 시 컨테이너 사전 부팅(Hot-Start)을 위한 선제 핑 — 즉시 반환
  if (req.query.warmup === 'true' || (req.body && req.body.warmup === 'true')) {
    return res.json({ success: true, message: "warmed up" });
  }

  const uid = await verifyRegisteredUser(req, res, { includeAccountRole: true });
  if (!uid) return;

  try {
    const accountRole = await getVerifiedAccountRole(req, uid);
    const start = Date.now();
    
    // 프로필·가입 판정과 인벤토리는 같은 backend 선택을 따른다.
    const [inventoryResult, profile] = await Promise.all([
      ensureInventoryV2(uid).then(data => ({ data })).catch(async error => {
        console.warn('[InventoryV2] 저장 실패, 기존 재고 반환:', error.message);
        return { ...await downloadInventory(uid), migrationFailed: true };
      }),
      getUserProfileRepository().read(uid)
    ]);
    
    let inventory = inventoryResult.data;
    let userData = profile.exists ? profile.value : {};
    // RTDB의 원본으로 표시를 유지한다. claims 갱신 지연은 가입/인벤토리 조회를 실패시키지 않는다.
    let membershipClaims = process.env.USER_STORAGE_BACKEND === 'rtdb'
      ? await require('../services/membershipClaims').syncMembershipClaims(uid) : undefined;
    if (membershipClaims?.status === 'synced'
        && membershipClaims.version !== require('../services/user-storage/membershipStore').membershipVersion(userData.settings?.membership)) {
      // 응답의 프로필 snapshot과 다른 버전으로 토큰 갱신을 지시하지 않는다.
      membershipClaims = { status: 'pending' };
    }
    const sourceMembership = normalizeSourceMembership(userData.settings?.membership);
    let userSettings = { ...(userData.settings || {}), membership: resolveEffectiveMembership(accountRole, sourceMembership) };

    let createdAt = userData.createdAt ? (userData.createdAt.toDate ? userData.createdAt.toDate().getTime() : userData.createdAt) : null;
    const nickname = userData.Nickname || "";

    // 신규 가입일은 completeRegistration에서만 생성한다. 기존 결측값은 추측하지 않는다.
    
    // 과거 배열형 집계만 저장 형식을 교정한다. 삭제 뒤 남는 rarity 0은
    // 기존 저장/변경 API 계약이므로 조회할 때 다시 저장하지 않는다.
    if (Array.isArray(inventory.locations) || Array.isArray(inventory.rarities)) {
      console.warn(`[Self-healing] Sanitizing inventory for UID: ${uid}`);
      inventory = await updateInventoryWithRetry(uid, current => {
        if (Array.isArray(current.locations)) current.locations = {};
        if (Array.isArray(current.rarities)) current.rarities = {};
      });
    }

    const amount = inventory.amount || 0;
    const locationsMap = inventory.locations || {};
    // 응답용 사본에서만 걸러 공유된 인벤토리 snapshot과 복구 원본을 보존한다.
    const raritiesMap = Object.fromEntries(Object.entries(inventory.rarities || {})
      .filter(([, count]) => !(count <= 0)));

    // cards 객체를 allCards 2D 배열로 변환
    const allCards = [];
    const namesSet = new Set();
    
    const cards = inventory.cards || {};
    for (const cardNo in cards) {
      const cardData = cards[cardNo];
      const cardName = cardData.name || "Unknown";
      
      if (cardData.items && Array.isArray(cardData.items)) {
        cardData.items.forEach(item => {
          if (item.qty > 0) {
            const rarity = item.rarity || item.proc || "기본";
            const illustration = item.illustration || item.another || "";
            const loc = item.loc || "미보관";
            
            allCards.push([cardName, cardNo, rarity, item.qty, loc, illustration, cardData.cid || null]);
            if (cardName !== "Unknown") namesSet.add(String(cardName));
          }
        });
      }
    }

    const end = Date.now();
    return res.json({
      success: true,
      lastUpdated: Date.now(),
      amount,
      locations: locationsMap,
      rarities: raritiesMap,
      names: Array.from(namesSet).sort(),
      allCards,
      inventoryVersion: inventory.version || 1,
      inventoryMigration: inventoryResult.migrationFailed
        ? { ...inventoryMigrationStatus(inventory), status: 'retryableError', retryAt: Date.now() + 30000 }
        : inventoryMigrationStatus(inventory),
      settings: userSettings,
      sourceMembership,
      ...(membershipClaims ? { membershipClaims } : {}),
      nickname,
      createdAt,
      debug: { serverTime: (end - start) }
    });
  } catch (e) {
    if (e.code === 'ACCOUNT_ROLE_UNAVAILABLE') return res.status(503).json({ success: false, code: e.code, message: e.message });
    console.error("getUserData error:", e);
    return res.status(500).json({ success: false, message: e.toString() });
  }
}, { allowWarmup: true });

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
