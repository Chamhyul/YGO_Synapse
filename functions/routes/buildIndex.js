const { onRequest } = require("firebase-functions/v2/https");
const { db, admin } = require("../config/firebase");
const { setCors, verifyUser } = require("../utils/auth");
const { normalizeText } = require("../utils/common");
const { normalizeNameForDocId } = require("../services/cardService");
const { uploadIndex, invalidateCache, rebuildCardManifestFromCache } = require("../utils/indexStorage");

/**
 * [일회성 마이그레이션 API] 기존 cards 컬렉션 데이터를 기반으로
 * idx_byNumber, idx_byName, idx_cid 인덱스를 Storage JSON으로 일괄 생성
 * 
 * 관리자 전용 - 한 번 실행 후 이후에는 saveCardToFirestore가 자동 관리
 */
exports.buildIndex = onRequest({ invoker: "public", memory: "1GiB", timeoutSeconds: 540 }, async (req, res) => {
  setCors(res, req);
  if (req.method === "OPTIONS") return res.status(204).send("");

  const uid = await verifyUser(req, res);
  if (!uid) return;

  try {
    const user = await admin.auth().getUser(uid);
    const claims = user.customClaims || {};
    const isAdmin = claims.admin === true || claims.role === "owner" || claims.role === "admin";
    if (!isAdmin) {
      return res.status(403).json({ success: false, error: "Forbidden: 관리자 권한이 필요합니다." });
    }
  } catch (e) {
    return res.status(403).json({ success: false, error: "Forbidden: 사용자 권한 확인 실패" });
  }

  const start = Date.now();
  let totalCards = 0;
  let totalByNumber = 0;
  let totalByName = 0;
  let totalByCid = 0;
  let errors = 0;

  try {
    console.log("[BuildIndex] Storage JSON 인덱스 생성 시작...");
    const cardsSnap = await db.collection("cards").get();
    totalCards = cardsSnap.size;
    console.log(`[BuildIndex] cards 컬렉션에서 ${totalCards}개 문서 발견`);

    // 3개의 인덱스 객체를 인메모리로 구축
    const idxByName = {};
    const idxByNumber = {};
    const idxCid = {};

    for (const doc of cardsSnap.docs) {
      const cid = doc.id;
      const data = doc.data();
      const info = data.info || {};

      try {
        const allNames = [];
        
        for (let langIdx = 0; langIdx < 10; langIdx++) {
          const langInfo = info[langIdx] || info[String(langIdx)];
          if (!langInfo) continue;

          const cardName = langInfo[0];
          const illustrationCount = langInfo[1] || 0;
          const raritiesByNo = langInfo[2] || {};

          if (!cardName) continue;

          const normName = normalizeText(cardName);
          if (normName && !allNames.includes(normName)) allNames.push(normName);

          // idx_byName 생성
          const nameDocId = normalizeNameForDocId(cardName);
          if (!idxByName[nameDocId]) {
            idxByName[nameDocId] = { cid, illustrationCount };
          } else {
            if (illustrationCount > (idxByName[nameDocId].illustrationCount || 0)) {
              idxByName[nameDocId].illustrationCount = illustrationCount;
            }
          }
          for (const no in raritiesByNo) {
            const upperNo = no.toUpperCase();
            const rarArr = raritiesByNo[no];
            idxByName[nameDocId][upperNo] = rarArr.length > 1 ? rarArr.slice(1) : [];
          }
          totalByName++;

          // idx_byNumber 생성
          for (const no in raritiesByNo) {
            const upperNo = no.toUpperCase();
            const rarArr = raritiesByNo[no];
            const rarities = rarArr.length > 1 ? rarArr.slice(1) : [];
            idxByNumber[upperNo] = { cid, name: cardName, illustrationCount, rarity: rarities };
            totalByNumber++;
          }
        }

        // idx_cid 생성
        if (allNames.length > 0) {
          if (idxCid[cid]) {
            const existing = idxCid[cid].names || [];
            allNames.forEach(n => { if (!existing.includes(n)) existing.push(n); });
            idxCid[cid].names = existing;
          } else {
            idxCid[cid] = { names: allNames };
          }
          totalByCid++;
        }

      } catch (cardErr) {
        errors++;
        console.warn(`[BuildIndex] CID ${cid} 처리 실패:`, cardErr.message);
      }
    }

    // Storage에 3개 인덱스 파일 업로드
    console.log("[BuildIndex] Storage에 인덱스 파일 업로드 중...");
    await Promise.all([
      uploadIndex("byName", idxByName),
      uploadIndex("byNumber", idxByNumber),
      uploadIndex("cid", idxCid),
    ]);

    // 캐시 무효화 및 매니페스트 재빌드
    invalidateCache();
    await rebuildCardManifestFromCache();

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    const result = {
      success: true,
      totalCards,
      totalByNumber,
      totalByName,
      totalByCid,
      errors,
      elapsedSeconds: elapsed,
      message: `Storage JSON 인덱스 생성 완료 (${elapsed}초 소요)`
    };

    console.log(`[BuildIndex] 완료:`, result);
    return res.json(result);

  } catch (e) {
    console.error("[BuildIndex] 치명적 오류:", e);
    return res.status(500).json({ success: false, message: e.toString() });
  }
});
