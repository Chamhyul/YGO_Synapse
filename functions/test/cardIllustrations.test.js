const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCardDetailHtml } = require('../scrapers/cardScraper');

test('썸네일 개수가 아니라 실제 ciid 목록을 언어 슬롯에 기록한다', () => {
  const html = `<div id="cardname"><h1>블랙 매지션</h1></div><div id="thumbnail">
    <img id="thumbnail_card_image_1" alt="1" src="/yugiohdb/get_image.action?type=1&amp;cid=4041&amp;ciid=1">
    <img id="thumbnail_card_image_9" alt="9" src="/yugiohdb/get_image.action?type=1&amp;cid=4041&amp;ciid=9">
    <img id="thumbnail_card_image_15" alt="15" src="/yugiohdb/get_image.action?type=1&amp;cid=4041&amp;ciid=15">
  </div>`;
  const parsed = parseCardDetailHtml(html, 'ko');
  assert.deepEqual(parsed.mergedInfoSlot[0][1], [1, 9, 15]);
  assert.deepEqual(parsed.illustrationIds, [1, 9, 15]);
});
