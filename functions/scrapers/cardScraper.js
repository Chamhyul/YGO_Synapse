/**
 * 카드 info / mergedInfo의 위치별 의미 (Firestore에서는 숫자 문자열 키의 Map으로 저장):
 * 0~9: ko, ja, ae, cn, en, de, fr, it, es, pt 순서의 언어별 정보.
 *   각 언어 배열: [카드명, 일러스트 수, 번호별 레어도 정보, 일반 효과, 펜듈럼 효과].
 *   번호별 레어도 정보: { 카드번호: [팩 이름, 레어도1, 레어도2, ...] }.
 * 10: 카드 종류 (0 몬스터, 1 마법, 2 함정).
 * 11: 세부 분류 배열 (ETCs 목록의 인덱스; 마법/함정 분류는 15부터).
 * 12: 레벨 / 랭크 / 링크 수치.
 * 13: 속성 (ATTRIBUTEs 목록의 인덱스), 14: 종족 (TYPEs 목록의 인덱스).
 * 15: 공격력, 16: 수비력 ('?'는 -1), 17: 펜듈럼 스케일.
 * 미수집 항목은 null 또는 키 부재로 표현하며, 배열 순서는 클라이언트와 공유합니다.
 */
/**
 * scraper.js
 * Code.js의 parseCardDetailHtml_, crawlAndSaveCard_ 로직을 Node.js로 이식
 */
const cheerio = require("cheerio");
const axios = require("axios");
const { normalizeText } = require("../utils/common");

/**
 * 배열 항목을 chunkSize 단위로 나누어 병렬 수행하는 유틸리티
 */
async function chunkParallelFetch(items, chunkSize, fetchFn) {
  const results = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    const chunk = items.slice(i, i + chunkSize);
    const chunkResults = await Promise.all(chunk.map(item => fetchFn(item)));
    results.push(...chunkResults);
  }
  return results;
}

const SEARCH_ORDER = ["ko", "ja", "ae", "cn", "en", "de", "fr", "it", "es", "pt"];
const LOCALE_TO_INDEX = { ko: 0, ja: 1, ae: 2, cn: 3, en: 4, de: 5, fr: 6, it: 7, es: 8, pt: 9 };
const LOCALE_MAP = { KR: "ko", JP: "ja", AE: "ae", SC: "cn", EN: "en", DE: "de", FR: "fr", IT: "it", SP: "es", PT: "pt" };

const REQUEST_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

const ATTRIBUTEs = [
  ["어둠", "빛", "땅", "물", "화염", "바람", "신"],
  ["闇属性", "光属性", "地属性", "水属性", "炎属性", "風属性", "神属性"],
  ["DARK", "LIGHT", "EARTH", "WATER", "FIRE", "WIND", "DIVINE"],
  ["暗属性", "光属性", "地属性", "水属性", "炎属性", "风属性", "神属性"],
  ["DARK", "LIGHT", "EARTH", "WATER", "FIRE", "WIND", "DIVINE"],
  ["FINSTERNIS", "LICHT", "ERDE", "WASSER", "FEUER", "WIND", "GÖTTLICH"],
  ["TÉNÈBRES", "LUMIÈRE", "TERRE", "EAU", "FEU", "VENT", "DIVIN"],
  ["OSCURITÀ", "LUCE", "TERRA", "ACQUA", "FUOCO", "VENTO", "DIVINO"],
  ["OSCURIDAD", "LUZ", "TIERRA", "AGUA", "FUEGO", "VIENTO", "DIVINIDAD"],
  ["TREVAS", "LUZ", "TERRA", "ÁGUA", "FOGO", "VENTO", "DIVINO"],
];
const TYPEs = [
  ["드래곤족", "언데드족", "악마족", "화염족", "해룡족", "암석족", "기계족", "어류족", "공룡족", "곤충족", "야수족", "야수전사족", "식물족", "물족", "전사족", "비행야수족", "천사족", "마법사족", "번개족", "파충류족", "창조신족", "환신야수족", "사이킥족", "환룡족", "사이버스족", "환상마족"],
  ["ドラゴン族", "アンデット族", "悪魔族", "炎族", "海竜族", "岩石族", "機械族", "魚族", "恐竜族", "昆虫族", "獣族", "獣戦士族", "植物族", "水族", "戦士族", "鳥獣族", "天使族", "魔法使い族", "雷族", "爬虫類族", "創造神族", "幻神獣族", "サイキック族", "幻竜族", "サイバース族", "幻想魔族"],
  ["Dragon", "Zombie", "Fiend", "Pyro", "Sea Serpent", "Rock", "Machine", "Fish", "Dinosaur", "Insect", "Beast", "Beast-Warrior", "Plant", "Aqua", "Warrior", "Winged Beast", "Fairy", "Spellcaster", "Thunder", "Reptile", "Creator God", "Divine-Beast", "Psychic", "Wyrm", "Cyberse", "Illusion"],
  ["龙族", "不死族", "恶魔族", "炎族", "海龙族", "岩石族", "机械族", "鱼族", "恐龙族", "昆虫族", "兽族", "兽战士族", "植物族", "水族", "战士族", "鸟兽族", "天使族", "魔法师族", "雷族", "爬虫类族", "创造神族", "幻神兽族", "念动力族", "幻龙族", "电子界族", "幻想魔族"],
  ["Dragon", "Zombie", "Fiend", "Pyro", "Sea Serpent", "Rock", "Machine", "Fish", "Dinosaur", "Insect", "Beast", "Beast-Warrior", "Plant", "Aqua", "Warrior", "Winged Beast", "Fairy", "Spellcaster", "Thunder", "Reptile", "Creator God", "Divine-Beast", "Psychic", "Wyrm", "Cyberse", "Illusion"],
  ["Drache", "Zombie", "Unterweltler", "Pyro", "Seeschlange", "Fels", "Maschine", "Fisch", "Dinosaurier", "Insekt", "Ungeheuer", "Ungeheuer-Krieger", "Pflanze", "Aqua", "Krieger", "Geflügeltes Ungeheuer", "Fee", "Hexer", "Donner", "Reptil", "Schöpfergott", "Göttliches Ungeheuer", "Psi", "Wyrm", "Cyberse", "Illusion"],
  ["Dragon", "Zombie", "Démon", "Pyro", "Serpent de Mer", "Rocher", "Machine", "Poisson", "Dinosaure", "Insecte", "Bête", "Bête-Guerrier", "Plante", "Aqua", "Guerrier", "Bête Ailée", "Elfe", "Magicien", "Tonnerre", "Reptile", "Dieu Créateur", "Bête Divine", "Psychique", "Wyrm", "Cyberse", "Illusion"],
  ["Drago", "Zombie", "Demone", "Pyro", "Serpente Marino", "Roccia", "Macchina", "Pesce", "Dinosauro", "Insetto", "Bestia", "Guerriero-Bestia", "Pianta", "Acqua", "Guerriero", "Bestia Alata", "Fata", "Incantatore", "Tuono", "Rettile", "Dio Creatore", "Divinità-Bestia", "Psichico", "Wyrm", "Cyberse", "Illusione"],
  ["Dragón", "Zombi", "Demonio", "Piro", "Serpiente Marina", "Roca", "Máquina", "Pez", "Dinosaurio", "Insecto", "Bestia", "Guerrero-Bestia", "Planta", "Aqua", "Guerrero", "Bestia Alada", "Hada", "Lanzador de Conjuros", "Trueno", "Reptil", "Dios Creador", "Bestia Divina", "Psíquico", "Wyrm", "Ciberso", "Ilusión"],
  ["Dragão", "Zumbi", "Demônio", "Piro", "Serpente Marinha", "Rocha", "Máquina", "Peixe", "Dinossauro", "Inseto", "Besta", "Besta-Guerreira", "Planta", "Água", "Guerreiro", "Besta Alada", "Fada", "Mago", "Trovão", "Réptil", "Deus Criador", "Besta Divina", "Psíquico", "Wyrm", "Ciberso", "Ilusão"],
];
const ETCs = [
  ["일반", "효과", "의식", "융합", "싱크로", "엑시즈", "펜듈럼", "스피릿", "툰", "튜너", "유니온", "듀얼", "리버스", "링크", "특수 소환"],
  ["通常", "効果", "儀式", "融合", "シンクロ", "エクシーズ", "ペンデュラム", "スピリット", "トゥーン", "チューナー", "ユニオン", "デュアル", "リバース", "リンク", "特殊召喚"],
  ["Normal", "Effect", "Ritual", "Fusion", "Synchro", "Xyz", "Pendulum", "Spirit", "Toon", "Tuner", "Union", "Gemini", "Flip", "Link", "Special Summon"],
  ["通常", "效果", "仪式", "融合", "同调", "超量", "灵摆", "灵魂", "卡通", "调整", "同盟", "二重", "反转", "连接", "特殊召唤"],
  ["Normal", "Effect", "Ritual", "Fusion", "Synchro", "Xyz", "Pendulum", "Spirit", "Toon", "Tuner", "Union", "Gemini", "Flip", "Link", "Special Summon"],
  ["Normal", "Effekt", "Ritual", "Fusion", "Synchro", "Xyz", "Pendel", "Spirit", "Toon", "Empfänger", "Union", "Zwilling", "Flipp", "Link", "Spezialbeschwörung"],
  ["Normal", "Effet", "Rituel", "Fusion", "Synchro", "Xyz", "Pendule", "Esprit", "Toon", "Syntoniseur", "Union", "Gémeau", "Flip", "Lien", "Invocation Spéciale"],
  ["Normale", "Effetto", "Rituale", "Fusione", "Synchro", "Xyz", "Pendulum", "Spirito", "Toon", "Tuner", "Unione", "Gemelli", "Scoperta", "Link", "Evocazione Speciale"],
  ["Normal", "Efecto", "Ritual", "Fusión", "Sincronía", "Xyz", "Péndulo", "Espíritu", "Toon", "Cantante", "Unión", "Géminis", "Volteo", "Enlace", "Invocación Especial"],
  ["Normal", "Efeito", "Ritual", "Fusão", "Sincro", "Xyz", "Pêndulo", "Espírito", "Toon", "Regulador", "União", "Gêmeos", "Virar", "Link", "Invocação-Especial"],
];
const MAGIC_TRAP_TYPES = [
  ["일반 마법", "지속 마법", "속공 마법", "필드 마법", "장착 마법", "의식 마법", "일반 함정", "지속 함정", "카운터 함정"],
  ["通常魔法", "永続魔法", "速攻魔法", "フィールド魔法", "装備魔法", "儀式魔法", "通常罠", "永続罠", "カウンター罠"],
  ["Normal Spell", "Continuous Spell", "Quick-Play Spell", "Field Spell", "Equip Spell", "Ritual Spell", "Normal Trap", "Continuous Trap", "Counter Trap"],
  ["通常 魔法", "永续 魔法", "速攻 魔法", "场地 魔法", "装备 魔法", "仪式 魔法", "通常 陷阱", "永续 陷阱", "反击 陷阱"],
  ["Normal Spell", "Continuous Spell", "Quick-Play Spell", "Field Spell", "Equip Spell", "Ritual Spell", "Normal Trap", "Continuous Trap", "Counter Trap"],
  ["Normal Zauber", "Permanent Zauber", "Schnell Zauber", "Spielfeld Zauber", "Ausrüstung Zauber", "Ritual Zauber", "Normal Fallen", "Permanent Fallen", "Konter Fallen"],
  ["Normale Magie", "Continu Magie", "Jeu-Rapide Magie", "Terrain Magie", "Équipement Magie", "Rituel Magie", "Normale Piège", "Continu Piège", "Contre Piège"],
  ["Normali Magia", "Continua Magia", "Rapida Magia", "Terreno Magia", "Equipaggiamento Magia", "Rituale Magia", "Normali Trappola", "Continua Trappola", "Contro Trappola"],
  ["Normales Mágica", "Continua Mágica", "Juego Rápido Mágica", "Campo Mágica", "Equipo Mágica", "Ritual Mágica", "Normales Trampa", "Continua Trampa", "Contraefecto Trampa"],
  ["Normal Magia", "Contínua Magia", "Rápida Magia", "Campo Magia", "Equipamento Magia", "Ritual Magia", "Normal Armadilha", "Contínua Armadilha", "Marcador Armadilha"],
];

/**
 * HTML 파싱 (Code.js의 parseCardDetailHtml_ 이식)
 */
function parseCardDetailHtml(htmlText, locale) {
  const $ = cheerio.load(htmlText);
  if ($("#cardname").length === 0) return null;

  const locIdx = LOCALE_TO_INDEX[locale] || 0;

  const parsedName = $("#cardname h1").clone().children("span").remove().end().text().trim();
  if (!parsedName) return null;

  const primaryAnotherCount = $(".set img").length || 0;
  const locCardNumbers = [];
  const rarsByNo = {};
  const allRarities = [];

  $(".t_row").each(function () {
    const rowCardNo = $(this).find(".card_number").text().trim().toUpperCase() || "(번호 없음)";
    if (rowCardNo !== "(번호 없음)" && !locCardNumbers.includes(rowCardNo)) locCardNumbers.push(rowCardNo);

    const $iconRarity = $(this).find(".icon.rarity");
    if ($iconRarity.length === 0) return;

    const pk = $iconRarity.find("span").text().trim().replace(/（/g, "(").replace(/）/g, ")");
    const pd = $iconRarity.find("p").text().trim().replace(/（/g, "(").replace(/）/g, ")") || pk;

    const rowPackName = $(this).find(".pack_name").text().trim();
    allRarities.push({ no: rowCardNo, key: pk || "Unknown", display: pd || "Unknown", locale, packName: rowPackName });
    if (!rarsByNo[rowCardNo]) rarsByNo[rowCardNo] = [rowPackName || ""];
    if (!rarsByNo[rowCardNo].includes(pk || "Unknown")) rarsByNo[rowCardNo].push(pk || "Unknown");
  });

  let attrStr = "", levelStr = "", typeStr = "", atkStr = "", defStr = "";
  const $imgSet = $(".frame.imgset");

  $imgSet.find(".item_box").each(function () {
    const title = $(this).find(".item_box_title");
    const val = $(this).find(".item_box_value").text().trim();
    if (title.find("img").attr("alt") && title.text().trim().length === 0) attrStr = val;
  });
  if (!attrStr) attrStr = $imgSet.find(".item_box_value img, .item_box_title img").first().attr("alt") || $imgSet.find(".item_box_value").first().text().trim();

  // 2번째 item_box (인덱스 1)에서 레벨 / 랭크 / 링크 수치 정밀 추출
  const $levelBoxValue = $imgSet.find(".item_box").eq(1).find(".item_box_value");
  if ($levelBoxValue.length > 0) {
    const levelBoxTxt = $levelBoxValue.text().trim();
    const nm = levelBoxTxt.match(/\d+/);
    if (nm) levelStr = nm[0];
  }

  // Fallback: 예외 상황 대비 텍스트 검색
  if (!levelStr) {
    $imgSet.find(".item_box_value").each(function () {
      const txt = $(this).text().trim();
      const numMatch = txt.match(/\d+/);
      if (numMatch && /레벨|Level|ランク|랭크|링크|LINK|Link|リンク/.test(txt)) levelStr = numMatch[0];
    });
  }

  $(".CardText .frame").each(function () {
    $(this).find(".item_box").each(function () {
      const tt = $(this).find(".item_box_title").text().trim();
      const vt = $(this).find(".item_box_value").text().trim();
      if (tt === "ATK") atkStr = vt;
      if (tt === "DEF") defStr = vt;
    });
  });

  const speciesSpans = [];
  $("p.species span").each(function () {
    const t = $(this).text().trim();
    if (t && t !== "／" && t !== "/") speciesSpans.push(t);
  });
  if (speciesSpans.length > 0) typeStr = speciesSpans.join("/");

  let magicTrapTypeIdx = -1;
  $(".item_box.t_center .item_box_value").each(function () {
    const txt = normalizeText($(this).text());
    if (!txt) return;
    if (MAGIC_TRAP_TYPES[locIdx]) {
      const foundIdx = MAGIC_TRAP_TYPES[locIdx].findIndex(mt => {
        const normMt = mt.replace(/\s+/g, " ").trim();
        return txt === normMt || txt.includes(normMt);
      });
      if (foundIdx > -1) {
        magicTrapTypeIdx = foundIdx;
      }
    }
  });

  let cardKindAttr = "";
  if (magicTrapTypeIdx > -1) {
    cardKindAttr = magicTrapTypeIdx <= 5 ? "spell" : "trap";
  } else {
    $(".CardText .frame .item_box").each(function () {
      const altText = $(this).find(".item_box_title img").attr("alt") || $(this).find(".item_box_value img").attr("alt") || "";
      const valueText = $(this).find(".item_box_value").text().trim();
      const combinedText = altText + " " + valueText;
      if (/마법|魔法|Spell|Zauber|Magie|Magia|Mágicas|Magia/i.test(combinedText)) cardKindAttr = "spell";
      if (/함정|罠|Trap|陷阱|Fallen|Piège|Trappola|Trampa|Armadilha/i.test(combinedText)) cardKindAttr = "trap";
    });
  }
  if (!attrStr && cardKindAttr) attrStr = cardKindAttr;

  let cardText = "";
  let $normalTextEl = $(".CardText").not(".pen").find(".item_box_text").first();
  if ($normalTextEl.length === 0) {
    $normalTextEl = $(".item_box_text").first();
  }
  if ($normalTextEl.length > 0) {
    const $clone = $normalTextEl.clone();
    $clone.find(".text_title").remove();
    $clone.find("br").replaceWith("\n");
    cardText = $clone.text()
      // HTML 엔티티에서 텍스트로 풀린 br 표기도 실제 개행으로 통일합니다.
      .replace(/<br\s*\/?\s*>/gi, "\n")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .split("\n")
      .map(line => line.trim().replace(/[ \t]+/g, " "))
      .join("\n")
      .trim();
  }

  let penText = "";
  const $penTextEl = $(".CardText.pen .frame.pen_effect .item_box_text").first();
  if ($penTextEl.length > 0) {
    const $clone = $penTextEl.clone();
    $clone.find(".text_title").remove();
    $clone.find("br").replaceWith("\n");
    penText = $clone.text()
      .replace(/<br\s*\/?\s*>/gi, "\n")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .split("\n")
      .map(line => line.trim().replace(/[ \t]+/g, " "))
      .join("\n")
      .trim();
  }

  const mergedInfoSlot = new Array(18).fill(null);
  mergedInfoSlot[locIdx] = [parsedName, primaryAnotherCount, rarsByNo, cardText, penText];

  const scaleText = $(".CardText.pen .item_box.pen_s .item_box_value").text();
  const scaleMatch = scaleText.match(/\d+/);
  if (scaleMatch) {
    mergedInfoSlot[17] = parseInt(scaleMatch[0], 10);
  }

  if (attrStr || typeStr || magicTrapTypeIdx > -1) {
    if (attrStr) {
      const aIdx = ATTRIBUTEs[locIdx].indexOf(attrStr);
      if (aIdx > -1) mergedInfoSlot[13] = aIdx;
    }
    if (typeStr) {
      typeStr = typeStr.replace(/\[|\]|【|】/g, "").trim();
      typeStr.split(/[/／]/).forEach((part) => {
        part = part.trim();
        if (!part) return;
        const tIdx = TYPEs[locIdx].indexOf(part);
        if (tIdx > -1) mergedInfoSlot[14] = tIdx;
        else {
          const eIdx = ETCs[locIdx].indexOf(part);
          if (eIdx > -1) {
            if (!mergedInfoSlot[11]) mergedInfoSlot[11] = [];
            if (!mergedInfoSlot[11].includes(eIdx)) mergedInfoSlot[11].push(eIdx);
          }
        }
      });
    }
    if (magicTrapTypeIdx > -1) {
      const stIdx = magicTrapTypeIdx + 15;
      if (!mergedInfoSlot[11]) mergedInfoSlot[11] = [];
      if (!mergedInfoSlot[11].includes(stIdx)) mergedInfoSlot[11].push(stIdx);
    }
    if (atkStr || defStr || levelStr || typeStr) mergedInfoSlot[10] = 0;
    else if (cardKindAttr === "spell") mergedInfoSlot[10] = 1;
    else if (cardKindAttr === "trap") mergedInfoSlot[10] = 2;
    if (levelStr) { const nm = levelStr.match(/\d+/); if (nm) mergedInfoSlot[12] = parseInt(nm[0], 10); }
    if (atkStr) mergedInfoSlot[15] = atkStr.includes("?") ? -1 : parseInt(atkStr, 10) || 0;
    if (defStr) mergedInfoSlot[16] = defStr.includes("?") ? -1 : parseInt(defStr, 10) || 0;
  }

  return { mergedInfoSlot, newRarities: allRarities, primaryName: parsedName, primaryAnotherCount };
}

/**
 * 카드 번호로 크롤링 (Code.js의 crawlAndSaveCard_ type:'no' 이식)
 */
async function crawlByCardNo(cardNo) {
  const query = cardNo.trim().toUpperCase();
  const regionMatch = query.match(/-([A-Z]+)/);
  const targetLocales = (regionMatch && LOCALE_MAP[regionMatch[1]]) ? [LOCALE_MAP[regionMatch[1]]] : SEARCH_ORDER;

  // Step 1: 검색 페이지에서 detailLink 찾기
  const searchResults = await Promise.all(
    targetLocales.map((loc) =>
      axios.get(`https://www.db.yugioh-card.com/yugiohdb/card_search.action?ope=1&stype=4&rp=100&keyword=${encodeURIComponent(query)}&request_locale=${loc}`, { headers: REQUEST_HEADERS, responseType: 'text' })
        .then((r) => r.data)
        .catch(() => null)
    )
  );

  let detailLink = null, foundLocale = null, validLocales = [];
  for (let i = 0; i < searchResults.length; i++) {
    if (!searchResults[i]) continue;
    const $ = cheerio.load(searchResults[i]);
    if ($("span.card_name").length === 1) {
      const linkVal = $("input.link_value").first().attr("value");
      if (linkVal) { detailLink = linkVal; foundLocale = targetLocales[i]; validLocales.push(targetLocales[i]); break; }
    }
  }
  if (!detailLink) return { name: "번호 확인", isError: true };

  return await _crawlDetail(detailLink, foundLocale, validLocales, "no", query);
}

/**
 * 카드 이름으로 크롤링 (Code.js의 crawlAndSaveCard_ type:'name' 이식)
 */
async function crawlByCardName(cardName) {
  const normName = normalizeText(cardName);

  // 각 언어별 검색 태스크 정의
  const searchTasks = SEARCH_ORDER.map(async (loc) => {
    let currentPage = 1;
    let totalPages = 1;
    let foundLink = null;

    try {
      while (currentPage <= totalPages) {
        const url = `https://www.db.yugioh-card.com/yugiohdb/card_search.action?ope=1&stype=1&rp=100&keyword=${encodeURIComponent(cardName)}&request_locale=${loc}&page=${currentPage}`;
        const res = await axios.get(url, { headers: REQUEST_HEADERS, responseType: 'text' }).catch(() => null);
        if (!res || !res.data) break;
        
        const html = res.data;
        const $ = cheerio.load(html);

        // 검색 결과 없음 확인
        if ($("#no_data").length > 0) break;

        // 전체 건수 확인 및 총 페이지 수 계산 (1페이지에서만 수행)
        if (currentPage === 1) {
          const resultText = $("#sort_set #text").text().trim();
          const numbers = resultText.match(/\d+/g);
          if (numbers) {
            const totalCount = Math.max(...numbers.map(Number));
            totalPages = Math.ceil(totalCount / 100);
          }
        }

        // 현재 페이지에서 카드 탐색
        let currentLink = null;
        $(".t_row").each(function () {
          const iterName = normalizeText($(this).find("span.card_name").text());
          if (iterName === normName) {
            currentLink = $(this).find("input.link_value").attr("value");
            return false;
          }
        });

        if (currentLink) {
          foundLink = currentLink;
          break; // 해당 언어에서 링크를 찾았으므로 다음 페이지 검색 중단 (언어 간 중단이 아님)
        }

        currentPage++;
      }
    } catch (e) {
      console.error(`crawlByCardName Task Error [${loc}]:`, e);
    }
    return foundLink ? { link: foundLink, locale: loc } : null;
  });

  // [중요] 모든 언어의 검색 프로세스가 완료될 때까지 전수 대기
  const results = await Promise.all(searchTasks);

  let detailLink = null, foundLocale = null;
  const validLocales = [];

  // 검색 결과가 존재하는 모든 언어를 수집
  results.forEach((res) => {
    if (res) {
      if (!detailLink) {
        detailLink = res.link;
        foundLocale = res.locale;
      }
      validLocales.push(res.locale);
    }
  });

  console.log(`[crawlByCardName] Search results for '${cardName}': detailLink=${detailLink}, validLocales=${JSON.stringify(validLocales)}`);

  if (!detailLink || validLocales.length === 0) return { name: "이름 확인", isError: true };

  // 수집된 모든 validLocales를 상세 크롤링 태스크로 전달하여 병합 처리
  return await _crawlDetail(detailLink, foundLocale, validLocales, "name", cardName);
}

/**
 * 상세 페이지 크롤링 및 결과 병합 (공통 로직)
 */
async function _crawlDetail(detailLink, foundLocale, validLocales, type, originalQuery) {
  console.log(`[_crawlDetail] Start crawling detail for type=${type}, detailLink=${detailLink}, validLocales=${JSON.stringify(validLocales)}`);
  
  if (!detailLink) {
    console.error("[_crawlDetail] Invalid detailLink:", detailLink);
    return { name: type === "no" ? "번호 확인" : "이름 확인", isError: true };
  }

  const baseUrl = detailLink.startsWith("http") ? detailLink : `https://www.db.yugioh-card.com${detailLink.startsWith("/") ? "" : "/"}${detailLink}`;
  const sep = baseUrl.includes("?") ? "&" : "?";

  const detailHtmls = await Promise.all(
    validLocales.map((loc) =>
      axios.get(`${baseUrl}${sep}request_locale=${loc}`, { headers: REQUEST_HEADERS, responseType: 'text' })
        .then((r) => r.data)
        .catch((err) => {
          console.warn(`[_crawlDetail] fetch failed for locale ${loc}:`, err.message || err);
          return null;
        })
    )
  );

  let primaryName = type === "name" ? originalQuery : "Unknown";
  let primaryAnotherCount = 0;
  const mergedCardInfo = new Array(18).fill(null);
  const allRarities = [];
  const resultsByCardNo = {};

  for (let d = 0; d < detailHtmls.length; d++) {
    if (!detailHtmls[d]) continue;
    const loc = validLocales[d];
    const locIdx = LOCALE_TO_INDEX[loc];
    const parsedData = parseCardDetailHtml(detailHtmls[d], loc);
    if (!parsedData) continue;

    if (parsedData.primaryAnotherCount > primaryAnotherCount) primaryAnotherCount = parsedData.primaryAnotherCount;
    if (loc === foundLocale && parsedData.primaryName) primaryName = parsedData.primaryName;

    allRarities.push(...parsedData.newRarities);
    mergedCardInfo[locIdx] = parsedData.mergedInfoSlot[locIdx];

    for (let mIdx = 10; mIdx < 18; mIdx++) {
      if (mIdx === 11) {
        if (parsedData.mergedInfoSlot[11]) {
          if (!mergedCardInfo[11]) mergedCardInfo[11] = [];
          parsedData.mergedInfoSlot[11].forEach((eIdx) => {
            if (!mergedCardInfo[11].includes(eIdx)) mergedCardInfo[11].push(eIdx);
          });
        }
      } else {
        if (mergedCardInfo[mIdx] === null && parsedData.mergedInfoSlot[mIdx] !== null) mergedCardInfo[mIdx] = parsedData.mergedInfoSlot[mIdx];
      }
    }

    parsedData.newRarities.forEach((item) => {
      if (!resultsByCardNo[item.no]) resultsByCardNo[item.no] = new Set();
      resultsByCardNo[item.no].add(item.key || "Unknown");
    });
  }

  // [메모리 최적화] 카드 메타 데이터 추출이 완료되었으므로 거대한 원본 HTML 텍스트 배열 참조를 즉시 해제
  // 인덱스 갱신 시점 전에 가비지 컬렉션이 거대한 HTML 문자열을 비울 수 있도록 명시적 null 처리
  let detailHtmlsCount = detailHtmls.length;
  detailHtmls.length = 0;

  const cidMatch = detailLink ? String(detailLink).match(/cid=(\d+)/) : null;
  const cid = cidMatch ? cidMatch[1] : String(detailLink || "");
  const raritiesOutput = {};
  for (const tk in resultsByCardNo) raritiesOutput[tk] = Array.from(resultsByCardNo[tk]);
  const targetRarities = (type === "no" && resultsByCardNo[originalQuery]) ? Array.from(resultsByCardNo[originalQuery]) : [];
  const extractedNumbers = [...new Set(allRarities.map((item) => item.no))];

  console.log(`[_crawlDetail] Successfully extracted CID: ${cid}, primaryName: ${primaryName}, numbers count: ${extractedNumbers.length}`);

  return {
    name: primaryName,
    isCached: false,
    numbers: extractedNumbers,
    anotherCount: primaryAnotherCount,
    linkData: { id: cid, locale: foundLocale || "ko" },
    rarities: targetRarities,
    raritiesByNo: raritiesOutput,
    mergedInfo: mergedCardInfo,
    newRarities: allRarities,
    cid,
    validLocales,
  };
}

module.exports = { crawlByCardNo, crawlByCardName, parseCardDetailHtml, searchPack, crawlCardInPack, getPackCids, getAllPacks, LOCALE_TO_INDEX };

/**
 * 팩 ID로부터 소속 카드 CID 리스트 추출
 */
async function getPackCids(packId, locale = 'ko') {
  const url = `https://www.db.yugioh-card.com/yugiohdb/card_search.action?ope=1&pid=${packId}&rp=99999&request_locale=${locale}`;
  try {
    const res = await axios.get(url, {
      headers: REQUEST_HEADERS,
      timeout: 10000
    });
    if (res.status !== 200) return { isError: true, message: "Server Error" };

    const $ = cheerio.load(res.data);
    const cids = [];
    $('.t_row input.link_value').each((i, elem) => {
      const val = $(elem).val();
      const cidMatch = val ? val.match(/cid=(\d+)/) : null;
      if (cidMatch) cids.push(cidMatch[1]);
    });

    // 팩 이름은 card_search.action의 경우 title이나 특정 h1 태그에서 파싱
    let packName = $('#broad_title h1, .broad_title h1, .text_title').text().trim() || "Unknown Pack";
    packName = normalizeText(packName);
    // "카드 검색" 같은 기본 텍스트면 치환
    if (packName === "카드 검색" || packName === "カード検索" || packName === "Card Search") {
      packName = "Unknown Pack";
    }

    // 중복 제거
    const uniqueCids = [...new Set(cids)];

    return { success: true, cids: uniqueCids, packName };
  } catch (e) {
    console.error("getPackCids error:", e);
    return { isError: true, message: e.toString() };
  }
}
async function searchPack(packName) {
  if (!packName) return { message: "팩 이름 미입력", isError: true };

  const searchName = normalizeText(packName);
  const locales = ['ko', 'ja', 'ae', 'cn', 'en', 'de', 'fr', 'it', 'es', 'pt'];

  try {
    // [최적화] 10개 언어를 한꺼번에 요청하지 않고 3개씩 끊어서 요청 (메모리 스파이크 방지)
    const responses = await chunkParallelFetch(locales, 3, loc =>
      axios.get(`https://www.db.yugioh-card.com/yugiohdb/card_list.action?request_locale=${loc}`, {
        headers: REQUEST_HEADERS,
        timeout: 10000
      }).then(res => ({ data: res.data, status: res.status, locale: loc }))
        .catch(err => ({ isError: true, locale: loc, message: err.message }))
    );

    const foundLocalesInfo = [];
    const foundLocalesSet = new Set();

    responses.forEach((res) => {
      if (res.isError || res.status !== 200) return;

      const $ = cheerio.load(res.data);
      $('.main').each((i, elem) => {
        const pName = normalizeText($(elem).find('p').text());
        if (pName === searchName) {
          const linkVal = $(elem).find('input.link_value').attr('value');
          if (linkVal) {
            const loc = res.locale;
            const pidMatch = linkVal.match(/(?:pid|cgid|tid|id)=([^&]+)/i);
            const pid = pidMatch ? pidMatch[1] : linkVal.replace(/[^0-9]/g, '');

            if (pid && !foundLocalesSet.has(loc)) {
              foundLocalesSet.add(loc);
              foundLocalesInfo.push({
                locale: loc,
                targetUrl: linkVal,
                packId: pid,
                packName: pName
              });
            }
          }
        }
      });
    });

    if (foundLocalesInfo.length === 0) return { success: false, message: "검색 결과 없음 (팩 이름 확인: " + packName + ")" };

    // [중요] 각 팩의 상세 페이지 방문하여 카드 수(totalCards) 및 CID 목록 추출 (Code.js 로직 이식)
    let maxTotalCards = 0;
    const detailRequests = foundLocalesInfo.map(info => {
      const baseUrl = info.targetUrl.startsWith("http") ? info.targetUrl : `https://www.db.yugioh-card.com${info.targetUrl}`;
      return axios.get(`${baseUrl}&request_locale=${info.locale}`, {
        headers: REQUEST_HEADERS,
        timeout: 15000 // 타임아웃 확대
      }).then(res => ({ data: res.data, info }))
        .catch(err => {
          console.warn(`Detail fetch failed for ${info.locale}:`, err.message);
          return null;
        });
    });

    const detailResponses = await Promise.all(detailRequests);

    for (let i = 0; i < detailResponses.length; i++) {
      const res = detailResponses[i];
      if (!res) continue;

      const info = res.info;
      const $detail = cheerio.load(res.data);
      const cardLinks = [];

      $detail('.t_row input.link_value').each((idx, el) => {
        const val = $detail(el).attr('value');
        if (val) cardLinks.push(val);
      });

      const totalFoundCards = cardLinks.length;
      if (totalFoundCards > maxTotalCards) maxTotalCards = totalFoundCards;

      // CID 추출 및 중복 제거 ([중요] 10배 중복 발생 방지)
      const rawCids = cardLinks.map(link => (link.match(/cid=(\d+)/) || [null, link.replace(/[^0-9]/g, '')])[1]);
      const uniqueCids = [...new Set(rawCids)];
      const finalTotal = uniqueCids.length;

      if (finalTotal > maxTotalCards) maxTotalCards = finalTotal;

      // foundLocalesInfo 업데이트
      const infoIdx = foundLocalesInfo.findIndex(f => f.packId === info.packId && f.locale === info.locale);
      if (infoIdx !== -1) {
        foundLocalesInfo[infoIdx].totalCards = finalTotal;
        foundLocalesInfo[infoIdx].cids = uniqueCids;
      }
    }

    return {
      success: true,
      foundLocales: foundLocalesInfo,
      isMultiple: foundLocalesInfo.length > 1,
      packName: foundLocalesInfo[0].packName,
      packId: foundLocalesInfo[0].packId,
      validLocale: foundLocalesInfo[0].locale,
      totalCards: maxTotalCards,
      cids: foundLocalesInfo[0].cids,
      message: foundLocalesInfo.length > 1 ? "발매 국가 선택" : "수록된 카드 " + maxTotalCards + "장 발견"
    };
  } catch (e) {
    console.error("searchPack error:", e);
    return { isError: true, message: e.toString() };
  }
}

/**
 * 팩 내 개별 카드 상세 정보 크롤링 (배치 처리를 위해 단건 기능 제공)
 */
async function crawlCardInPack(cid, locale = 'ko', packName = null) {
  const url = `https://www.db.yugioh-card.com/yugiohdb/card_search.action?ope=2&cid=${cid}&request_locale=${locale}`;
  try {
    const res = await axios.get(url, {
      headers: REQUEST_HEADERS,
      timeout: 10000
    });
    if (res.status !== 200) return { isError: true, message: "Server Error" };
    const parsedData = parseCardDetailHtml(res.data, locale);
    if (!parsedData) return { isError: true, message: "Parsing Error" };

    // [추가] 요청된 팩 이름과 일치하는 카드 번호 찾기 (Matched Number)
    let matchedFirstNo = "";
    if (packName) {
      const normTarget = normalizeText(packName);
      const found = parsedData.newRarities.find(r => {
        const normPack = normalizeText(r.packName);
        return normPack === normTarget;
      });
      if (found) matchedFirstNo = found.no;
    }

    return { ...parsedData, cid, cardNo: matchedFirstNo, mergedInfo: parsedData.mergedInfoSlot };
  } catch (e) {
    console.error(`crawlCardInPack error (cid: ${cid}):`, e);
    return { isError: true, cid, message: e.toString() };
  }
}

/**
 * 공식 웹페이지에서 전체 팩 목록의 PID와 이름을 추출
 * @param {string[]} locales - 조회할 언어 코드 배열
 * @returns {Promise<{pid: string, name: string, locale: string}[]>}
 */
async function getAllPacks(locales = ['ko']) {
  const allPacks = [];
  // [변경] PID+locale 복합키 기준으로 중복 체크: 동일 PID라도 locale이 다르면 별도 팩으로 수집
  const seenKeys = new Set();

  // 언어별로 3개씩 나눠서 요청 (메모리 스파이크 방지, searchPack과 동일 패턴)
  const responses = await chunkParallelFetch(locales, 3, loc =>
    axios.get(`https://www.db.yugioh-card.com/yugiohdb/card_list.action?request_locale=${loc}`, {
      headers: REQUEST_HEADERS,
      timeout: 15000
    }).then(res => ({ data: res.data, locale: loc }))
      .catch(err => {
        console.warn(`getAllPacks: ${loc} fetch failed:`, err.message);
        return null;
      })
  );

  for (const res of responses) {
      if (!res) continue;
      const $ = cheerio.load(res.data);
      $('.main').each((idx, elem) => {
        const packName = $(elem).find('p').text()
          .replace(/[\u200B-\u200D\uFEFF]/g, "")
          .replace(/\s+/g, " ")
          .trim()
          .normalize('NFC');
        const linkVal = $(elem).find('input.link_value').attr('value');
        if (!linkVal || !packName) return;

        const pidMatch = linkVal.match(/(?:pid|cgid|tid|id)=([^&]+)/i);
        const pid = pidMatch ? pidMatch[1] : linkVal.replace(/[^0-9]/g, '');

        // [변경] PID+locale 복합키로 중복 체크: 동일 PID의 다른 locale도 수집
        const compositeKey = `${pid}_${res.locale}`;
        if (pid && !seenKeys.has(compositeKey)) {
          seenKeys.add(compositeKey);
          allPacks.push({ pid, name: packName, locale: res.locale });
        }
      });
    }

  return allPacks;
}
