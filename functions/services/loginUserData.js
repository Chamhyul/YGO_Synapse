'use strict';
const { normalizeSourceMembership, resolveEffectiveMembership } = require('./membershipPolicy');
const { measure } = require('./inventoryRequestTiming');
const { getUserProfileRepository } = require('./userProfileRepository');
const { getVerifiedAccountRole } = require('../utils/auth');
const { downloadInventory, updateInventoryWithRetry } = require('../utils/inventoryStorage');
const { ensureInventoryV2, inventoryMigrationStatus } = require('./inventoryMigrationService');

// 로그인 진입에 필요한 계정 정보만 반환한다. 인벤토리·claims 동기화는
// 후속 인증 요청에서 수행하며 기존 전체 응답에 빈 카드 목록을 섞지 않는다.
async function readLoginAccountData(req, uid, { initialProfile } = {}) {
    const results = await Promise.allSettled([
      measure('login.account_role', () => getVerifiedAccountRole(req, uid)),
      measure('login.profile', () => initialProfile === undefined
        ? getUserProfileRepository().read(uid) : initialProfile),
    ]);
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
    const [role, profile] = results.map(result => result.value);
    const data = profile.exists ? profile.value : {};
    return {
      success: true,
      settings: { ...(data.settings || {}), membership: resolveEffectiveMembership(role, data.settings?.membership) },
      sourceMembership: normalizeSourceMembership(data.settings?.membership),
      nickname: data.Nickname || '',
      createdAt: data.createdAt ? (data.createdAt.toDate ? data.createdAt.toDate().getTime() : data.createdAt) : null,
    };
}

// 호출은 같은 HTTP 요청에서 인증·가입 판정을 끝낸 서버 경로로 제한한다.
async function readLoginUserData(req, uid, { initialProfile, membershipClaimsReadOnly = false,
    inventoryConditional = false, inventoryToken } = {}) {
    const start = Date.now();
    // 같은 인증 요청 안에서 독립 조회를 시작하고 모든 실패를 함께 회수한다.
    const results = await Promise.allSettled([
      measure('login.account_role', () => getVerifiedAccountRole(req, uid)),
      measure('login.inventory', async () => {
        try {
          if (inventoryConditional === true) {
            const read = require('../utils/inventoryStorage').readInventoryForSync;
            const result = typeof read === 'function' ? await read(uid, inventoryToken) : undefined;
            if (result) return result;
          }
          return { data: await ensureInventoryV2(uid) };
        } catch (error) {
        console.warn('[InventoryV2] 저장 실패, 기존 재고 반환:', error.message);
        return { ...await downloadInventory(uid), migrationFailed: true };
        }
      }),
      // 서버 가입 판정과 같은 검증된 snapshot이며 HTTP 입력에서 받지 않는다.
      measure('login.profile', () => initialProfile === undefined
        ? getUserProfileRepository().read(uid) : initialProfile),
      process.env.USER_STORAGE_BACKEND === 'rtdb'
        ? measure('login.claims', () => {
          const claims = require('./membershipClaims');
          return membershipClaimsReadOnly === true ? claims.readMembershipClaimsAfterVerification(uid)
            : claims.syncMembershipClaims(uid);
        }) : undefined,
    ]);
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
    const [accountRole, inventoryResult, profile, claims] = results.map(result => result.value);
    let membershipClaims = claims;
    let inventory = inventoryResult.data;
    const userData = profile.exists ? profile.value : {};
    if (membershipClaims?.status === 'synced'
        && membershipClaims.version !== require('./user-storage/membershipStore').membershipPermissionVersion(userData.settings?.membership)) {
      // 응답의 프로필 snapshot과 다른 버전으로 토큰 갱신을 지시하지 않는다.
      membershipClaims = { status: 'pending' };
    }
    const sourceMembership = normalizeSourceMembership(userData.settings?.membership);
    let userSettings = { ...(userData.settings || {}), membership: resolveEffectiveMembership(accountRole, sourceMembership) };

    let createdAt = userData.createdAt ? (userData.createdAt.toDate ? userData.createdAt.toDate().getTime() : userData.createdAt) : null;
    const nickname = userData.Nickname || "";

    if (inventoryResult.unchanged === true) return {
      success: true, lastUpdated: Date.now(), settings: userSettings, sourceMembership, nickname, createdAt,
      ...(membershipClaims ? { membershipClaims } : {}),
      inventorySync: { status: 'unchanged', token: inventoryResult.token },
      debug: { serverTime: Date.now() - start },
    };

    // 신규 가입일은 completeRegistration에서만 생성한다. 기존 결측값은 추측하지 않는다.

    // 과거 배열형 집계만 저장 형식을 교정한다. 삭제 뒤 남는 rarity 0은
    // 기존 저장/변경 API 계약이므로 조회할 때 다시 저장하지 않는다.
    if (Array.isArray(inventory.locations) || Array.isArray(inventory.rarities)) {
      console.warn('[Self-healing] Sanitizing inventory aggregates');
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
    return {
      success: true,
      lastUpdated: Date.now(),
      amount,
      locations: locationsMap,
      rarities: raritiesMap,
      names: Array.from(namesSet).sort(),
      allCards,
      inventoryVersion: inventory.version || 1,
      ...(inventoryConditional === true ? { inventorySync: { status: 'full',
        ...(inventoryResult.token ? { token: inventoryResult.token } : {}) } } : {}),
      inventoryMigration: inventoryResult.migrationFailed
        ? { ...inventoryMigrationStatus(inventory), status: 'retryableError', retryAt: Date.now() + 30000 }
        : inventoryMigrationStatus(inventory),
      settings: userSettings,
      sourceMembership,
      ...(membershipClaims ? { membershipClaims } : {}),
      nickname,
      createdAt,
      debug: { serverTime: (end - start) }
    };
}
module.exports = { readLoginUserData, readLoginAccountData };
