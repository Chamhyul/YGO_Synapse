const axios = require("axios");
const cheerio = require("cheerio");

const REQUEST_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

const DECK_DATABASE_HOST = "www.db.yugioh-card.com";

function isAllowedDeckDetailUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === "https:"
      && url.hostname === DECK_DATABASE_HOST
      && !url.port
      && !url.username
      && !url.password;
  } catch {
    return false;
  }
}

async function searchDeckByCode(deckCode, locale) {
  const url = `https://www.db.yugioh-card.com/yugiohdb/deck_search.action?deck_code=${encodeURIComponent(deckCode)}&request_locale=${encodeURIComponent(locale)}&ope=1&wname=MemberDeck`;

    const response = await axios.get(url, {
      headers: REQUEST_HEADERS,
      timeout: 15000,
    });

    const $ = cheerio.load(response.data);
    const rows = $(".t_row.deck_type_l");

    if (rows.length !== 1) {
      return { isError: true, message: "덱 코드를 확인하세요" };
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
      return { isError: true, message: "덱 코드를 확인하세요" };
    }

    return { success: true, deckName, updatedAt, detailUrl };
}

async function fetchDeckCards(detailUrl) {
  if (!isAllowedDeckDetailUrl(detailUrl)) throw new Error("허용되지 않은 덱 상세 URL입니다.");
    const response = await axios.get(detailUrl, {
      headers: REQUEST_HEADERS,
      timeout: 15000,
      // 허용 호스트가 아닌 곳으로의 리디렉션 우회를 차단합니다.
      maxRedirects: 0,
      validateStatus: status => status >= 200 && status < 300,
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

    return { success: true, cards };
}
module.exports = { isAllowedDeckDetailUrl, searchDeckByCode, fetchDeckCards };
