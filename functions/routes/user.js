const { onRequest } = require("firebase-functions/v2/https");
const { db, admin, getBucket, FieldValue } = require("../config/firebase");
const { setCors, verifyUser, verifyAppCheck } = require("../utils/auth");
const { downloadInventory, updateInventoryWithRetry, deleteInventory } = require("../utils/inventoryStorage");

const { ensureInventoryV2, inventoryMigrationStatus } = require('../services/inventoryMigrationService');

exports.clearUserData = onRequest({ invoker: "public" }, async (req, res) => {
  setCors(res, req);
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (!(await verifyAppCheck(req, res))) return;

  const uid = await verifyUser(req, res);
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

exports.getInitialData = onRequest({ invoker: "public", memory: "256MiB" }, async (req, res) => {
  setCors(res, req);
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (!(await verifyAppCheck(req, res))) return;

  try {
    const bucket = getBucket();
    const getResource = async (path, format) => {
      const file = bucket.file(path);
      try {
        const [metadata] = await file.getMetadata();
        const url = process.env.FUNCTIONS_EMULATOR === "true"
          ? `http://127.0.0.1:9199/download/storage/v1/b/${bucket.name}/o/${encodeURIComponent(path)}?alt=media`
          : `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(path)}?alt=media`;
        return { available: true, url, updatedAt: new Date(metadata.updated).getTime(),
          generation: String(metadata.generation), format };
      } catch (error) {
        if (Number(error.code) !== 404) console.warn(`[Sync] ${path} metadata error:`, error.message);
        return { available: false, url: null, updatedAt: 0, generation: null, format };
      }
    };

    const [cardManifest, packs, rarity] = await Promise.all([
      getResource("public/cardNames.json", "card-manifest-v2"),
      getResource("public/packs.json", "packs-v1"),
      getResource("public/rarityMapping.json", "rarity-langs-v1"),
    ]);

    return res.json({
      success: true,
      schemaVersion: 2,
      syncType: "storage-links",
      serverTime: Date.now(),
      resources: { cardManifest, packs, rarity },
    });
  } catch (e) {
    console.error("getInitialData error:", e);
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

  const uid = await verifyUser(req, res);
  if (!uid) return;

  try {
    const start = Date.now();
    
    // [Storage 전환] 인벤토리를 Storage에서 다운로드 + 설정, 기본 가입정보는 Firestore 유지
    const [inventoryResult, userSnap] = await Promise.all([
      ensureInventoryV2(uid).then(data => ({ data })).catch(async error => {
        console.warn('[InventoryV2] 저장 실패, 기존 재고 반환:', error.message);
        return { ...await downloadInventory(uid), migrationFailed: true };
      }),
      db.collection("users").doc(uid).get()
    ]);
    
    let inventory = inventoryResult.data;
    let userData = userSnap.exists ? userSnap.data() : {};
    let userSettings = userData.settings || {};

    let createdAt = userData.createdAt ? (userData.createdAt.toDate ? userData.createdAt.toDate().getTime() : userData.createdAt) : null;
    const nickname = userData.Nickname || "";

    // 가입일이 유실되었거나 최초 로그인인 경우 가입일 서버 측에서 기록
    if (!createdAt) {
      createdAt = Date.now();
      await db.collection("users").doc(uid).set({
        createdAt: FieldValue.serverTimestamp()
      }, { merge: true });
    }
    
    // Self-healing: 데이터 형식 교정
    let needsFix = false;
    if (Array.isArray(inventory.locations)) {
      inventory.locations = {}; needsFix = true;
    }
    if (Array.isArray(inventory.rarities)) {
      inventory.rarities = {}; needsFix = true;
    } else {
      for (const key in inventory.rarities) {
        if (inventory.rarities[key] <= 0) {
          delete inventory.rarities[key]; needsFix = true;
        }
      }
    }

    if (needsFix) {
      console.warn(`[Self-healing] Sanitizing inventory for UID: ${uid}`);
      inventory = await updateInventoryWithRetry(uid, current => {
        if (Array.isArray(current.locations)) current.locations = {};
        if (Array.isArray(current.rarities)) current.rarities = {};
        for (const key in current.rarities) if (current.rarities[key] <= 0) delete current.rarities[key];
      });
    }

    const amount = inventory.amount || 0;
    const locationsMap = inventory.locations || {};
    const raritiesMap = inventory.rarities || {};

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
      nickname,
      createdAt,
      debug: { serverTime: (end - start) }
    });
  } catch (e) {
    console.error("getUserData error:", e);
    return res.status(500).json({ success: false, message: e.toString() });
  }
});

exports.updateUserSettings = onRequest({ invoker: "public" }, async (req, res) => {
  setCors(res, req);
  if (req.method === "OPTIONS") return res.status(204).send("");

  const uid = await verifyUser(req, res);
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
    const userRef = db.collection("users").doc(uid);
    
    await userRef.set({
      settings: {
        ...filteredSettings,
        updatedAt: Date.now()
      }
    }, { merge: true });

    return res.json({ success: true, message: "설정이 성공적으로 저장되었습니다." });
  } catch (e) {
    console.error("updateUserSettings error:", e);
    return res.status(500).json({ success: false, message: e.toString() });
  }
});

exports.updateNickname = onRequest({ invoker: "public" }, async (req, res) => {
  setCors(res, req);
  if (req.method === "OPTIONS") return res.status(204).send("");
  
  const uid = await verifyUser(req, res);
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
    const userRef = db.collection("users").doc(uid);
    await userRef.set({
      Nickname: nickname.trim(),
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });

    return res.json({ success: true, message: "닉네임이 성공적으로 변경되었습니다." });
  } catch (e) {
    console.error("updateNickname error:", e);
    return res.status(500).json({ success: false, message: e.toString() });
  }
});
