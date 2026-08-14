const { onRequest } = require("firebase-functions/v2/https");
const { setCors, verifyAppCheck } = require("../utils/auth");
const axios = require("axios");
const cheerio = require("cheerio");

const REQUEST_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

exports.searchDeck = onRequest({ invoker: "public", memory: "512MiB", timeoutSeconds: 30 }, async (req, res) => {
  setCors(res, req);
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (!(await verifyAppCheck(req, res))) return;

  const deckCode = req.query.deckCode;
  const locale = req.query.locale || 'ko';
  if (!deckCode) return res.status(400).json({ isError: true, message: "덱 코드 미입력" });

  const url = `https://www.db.yugioh-card.com/yugiohdb/deck_search.action?deck_code=${encodeURIComponent(deckCode)}&request_locale=${encodeURIComponent(locale)}&ope=1&wname=MemberDeck`;

  try {
    const response = await axios.get(url, {
      headers: REQUEST_HEADERS,
      timeout: 15000,
    });

    const $ = cheerio.load(response.data);
    const rows = $(".t_row.deck_type_l");

    if (rows.length !== 1) {
      return res.json({ isError: true, message: "덱 코드를 확인하세요" });
    }

    const row = rows.first();
    const deckSet = row.find("div.dack_set.flex_1");

    const deckName = deckSet.find("div.text_set > span.name").text().trim();
    const updatedAt = deckSet.find("div.date.icon > span").text().trim();
    const detailPath = row.attr("href") || row.find("a").attr("href") || "";
    let detailUrl = "";
    if (detailPath) {
      detailUrl = detailPath.startsWith("http") ? detailPath : "https://www.db.yugioh-card.com" + detailPath;
    }

    if (!deckName) {
      return res.json({ isError: true, message: "덱 코드를 확인하세요" });
    }

    return res.json({ success: true, deckName, updatedAt, detailUrl });
  } catch (e) {
    console.error("searchDeck error:", e);
    return res.status(500).json({ isError: true, message: e.toString() });
  }
});

exports.getDeckCards = onRequest({ invoker: "public", memory: "512MiB", timeoutSeconds: 30 }, async (req, res) => {
  setCors(res, req);
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (!(await verifyAppCheck(req, res))) return;

  const detailUrl = req.query.url;
  if (!detailUrl) return res.status(400).json({ isError: true, message: "상세 URL 미입력" });

  try {
    const response = await axios.get(detailUrl, {
      headers: REQUEST_HEADERS,
      timeout: 15000,
    });

    const $ = cheerio.load(response.data);
    const cards = [];

    // id="deck_image" 아래 target="_blank" 요소 탐색
    $("#deck_image a[target='_blank'], #deck_image [target='_blank']").each((_, el) => {
      const title = $(el).find("span > img").attr("title") || $(el).find("img").attr("title");
      if (title) {
        cards.push({ name: title.trim() });
      }
    });

    return res.json({ success: true, cards });
  } catch (e) {
    console.error("getDeckCards error:", e);
    return res.status(500).json({ isError: true, message: e.toString() });
  }
});
