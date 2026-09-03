const { requestCardIndexWork } = require('./cardIndexDispatchService');
const { db } = require("../config/firebase");
const { normalizeText } = require("../utils/common");
const { searchPack, crawlCardInPack, getPackCids, LOCALE_TO_INDEX } = require("../scrapers/cardScraper");
const { saveCardToFirestore } = require("./cardService");
const { upsertPackToStorage, upsertPacksBatchToStorage, downloadPackDetail } = require("../utils/packsStorage");


async function searchPackByName(packName) {
  const result = await searchPack(packName);

  if (result && result.success && result.foundLocales) {
    // [Race Condition 수정] 배치 함수를 사용해 packs.json을 단 1회만 갱신
    const packsToSave = result.foundLocales.map(p => {
      p.targetUrl = p.packId;
      return {
        packId: `${p.packId}_${p.locale}`, // [변경] PID_locale 복합키 사용
        name: p.packName,
        totalCards: p.totalCards || 0,
        cids: p.cids || [],
        updatedAt: Date.now(),
      };
    });
    await upsertPacksBatchToStorage(packsToSave).catch(e => console.error("Pack batch save to Storage error:", e));
  }

  return result;
}

async function loadPackCids(packId, locale) {
  const result = await getPackCids(packId, locale || 'ko');

  if (result && !result.isError && result.cids) {
    await upsertPackToStorage(`${packId}_${locale || 'ko'}`, { // [변경] PID_locale 복합키 사용
      name: result.packName || packId,
      totalCards: result.cids.length,
      cids: result.cids,
      updatedAt: Date.now(),
    }).catch(e => console.error("Pack CIDs update to Storage error:", e));
  }

  return result;
}

async function crawlPackCardsBatch(options) {
  let { cids, locale, packId, offset } = options;
  offset = parseInt(offset || 0);

  try {
    let packName = options.packName || null;
    let dbCids = null;
    let packLocale = locale || 'ko';
    if (packId) {
      const compositeId = `${packId}_${packLocale}`; // [변경] PID_locale 복합키로 상세 파일 조회
      const packDetail = await downloadPackDetail(compositeId);
      if (packDetail) {
        packName = packDetail.name;
        dbCids = packDetail.cids;
      }
    }

    if (packId && (!cids || !Array.isArray(cids))) {
      if (dbCids && dbCids.length > 0) {
        cids = dbCids.slice(offset, offset + 20);
      } else {
        const packCidsRes = await getPackCids(packId, packLocale);
        if (packCidsRes.isError || !packCidsRes.cids) {
          return { isError: true, message: "팩 CID 목록을 가져오지 못했습니다." };
        }
        cids = packCidsRes.cids.slice(offset, offset + 20);
        if (!packName) packName = packCidsRes.packName;
      }
    }

    if (!cids || !Array.isArray(cids) || cids.length === 0) {
      return { cards: [], isDone: true, nextOffset: offset };
    }

    const results = [];
    // Firestore 일괄 조회 (순차 루프 → 1회 일괄 조회로 비용 및 지연 절감)
    const docRefs = cids.map(cid => db.collection("cards").doc(cid));
    const existingDocs = await db.getAll(...docRefs);
    const existingMap = new Map(existingDocs.map(doc => [doc.id, doc]));

    for (let i = 0; i < cids.length; i++) {
      const cid = cids[i];
      const doc = existingMap.get(cid);
      let shouldCrawl = false;
      let cachedInfo = null;
      let matchedNo = "";

      if (doc.exists) {
        const d = doc.data();
        cachedInfo = new Array(18).fill(null);
        if (d.info) {
          Object.keys(d.info).forEach(k => { cachedInfo[parseInt(k)] = d.info[k]; });
        }

        const localeIdx = LOCALE_TO_INDEX[packLocale];
        const cInfo = d.info ? d.info[localeIdx] : null;

        if (!cInfo || !cInfo[0]) {
          // 목표 언어 데이터 누락: 크롤링 강제
          shouldCrawl = true;
        } else {
          // 해당 언어 데이터가 이미 존재하는 경우: 팩 이름 매칭 검증 (3단계)
          if (packName && cInfo && cInfo[2]) {
            const raritiesObj = cInfo[2];
            const normTarget = normalizeText(packName);
            let isPackRecorded = false;
            for (const no in raritiesObj) {
              const rowPack = normalizeText(raritiesObj[no][0]);
              if (rowPack === normTarget) {
                matchedNo = no;
                isPackRecorded = true;
                break;
              }
            }
            if (!isPackRecorded) {
              // 언어 정보는 있으나 현재 팩의 카드 번호/레어리티 정보가 없는 재록 카드 ➔ 갱신 크롤링 강제
              shouldCrawl = true;
            }
          }
        }
      } else {
        shouldCrawl = true;
      }

      if (!shouldCrawl) {
        results.push({ cid, info: cachedInfo, index: offset + i, cardNo: matchedNo, isCached: true });
        continue;
      }

      const cardData = await crawlCardInPack(cid, packLocale, packName);
      if (!cardData.isError) {
        // 원본과 변경 대기 기록을 함께 저장하고 인덱스는 백엔드에서 일괄 반영합니다.
        await saveCardToFirestore(cardData, { deferIndexFlush: true }); 
        results.push({ cid, info: cardData.mergedInfo, cardNo: cardData.cardNo, index: offset + i, isCached: false });
      } else {
        results.push({ cid, index: offset + i, isError: true });
      }
    }

    if (results.some(result => result.isError)) throw new Error("일부 카드 수집에 실패했습니다. 저장된 카드의 인덱스 갱신은 계속됩니다.");
    const isDone = (cids.length < 20);
    const localeIdx = LOCALE_TO_INDEX[packLocale] || 0;

    return {
      success: true,
      results,
      cards: results.map(r => {
        let pureName = "Unknown";
        if (r.name) {
          pureName = r.name;
        } else if (r.info && r.info[localeIdx]) {
          pureName = r.info[localeIdx][0];
        }
        return { ...r, index: r.index, name: pureName, cardNo: r.cardNo || "", linkId: r.cid };
      }),
      isDone,
      nextOffset: offset + cids.length
    };
  } catch (e) {
    console.error("crawlPackBatch error:", e);
    throw e;
  } finally {
    // 응답을 보내기 전에 실제 인덱스 파일 저장을 실행합니다.
    await requestCardIndexWork();
  }
}
module.exports = { searchPackByName, loadPackCids, crawlPackCardsBatch };
