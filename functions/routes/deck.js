const { onRequest } = require("firebase-functions/v2/https");
const { setCors, verifyAppCheck } = require("../utils/auth");
const deckScraper = require("../scrapers/deckScraper");

exports.searchDeck = onRequest({ invoker: "public", memory: "256MiB", timeoutSeconds: 30 }, async (req, res) => {
  setCors(res, req);
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (!(await verifyAppCheck(req, res))) return;
  const deckCode = req.query.deckCode;
  if (!deckCode) return res.status(400).json({ isError: true, message: "덱 코드 미입력" });
  try {
    return res.json(await deckScraper.searchDeckByCode(deckCode, req.query.locale || 'ko'));
  } catch (error) {
    console.error('searchDeck error:', error);
    return res.status(500).json({ isError: true, message: '덱 검색에 실패했습니다.' });
  }
});

exports.getDeckCards = onRequest({ invoker: "public", memory: "256MiB", timeoutSeconds: 30 }, async (req, res) => {
  setCors(res, req);
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (!(await verifyAppCheck(req, res))) return;
  const detailUrl = req.query.url;
  if (!detailUrl || !deckScraper.isAllowedDeckDetailUrl(detailUrl)) {
    return res.status(400).json({ isError: true, message: '허용되지 않은 덱 상세 URL입니다.' });
  }
  try {
    return res.json(await deckScraper.fetchDeckCards(detailUrl));
  } catch (error) {
    console.error('getDeckCards error:', error);
    return res.status(500).json({ isError: true, message: '덱 카드 조회에 실패했습니다.' });
  }
});
