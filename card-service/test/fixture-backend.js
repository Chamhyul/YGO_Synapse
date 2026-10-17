'use strict';
// 공개 가능한 합성 데이터. SDK·자격증명·파일 쓰기를 사용하지 않는다.
const cards = {
  '42': { names: ['시험 카드', 'Test card'], numbers: ['TEST-001', 'DP15-JP001'],
    info: { 0: ['시험 카드', [1], { 'TEST-001': ['시험 팩', 'N'], 'DP15-JP001': ['시험 팩', 'N'] }], 10: 0, 12: 4 },
    raritiesByNo: { 'TEST-001': ['N'] }, internalAudit: '노출 금지' },
  '43': { names: ['같은 이름'], numbers: ['DUP-001'], info: {} },
  '44': { names: ['같은 이름'], numbers: ['DUP-002'], info: {} },
};
function createFixtureBackend() {
  const snapshot = id => ({ id, exists: Object.hasOwn(cards, id), data: () => structuredClone(cards[id]) });
  const db = {
    collection(name) {
      if (name !== 'cards') throw new Error('카드 이외 컬렉션 접근 금지');
      return { doc: id => ({ id }), where: (field, op, value) => {
        if (op !== 'array-contains') throw new Error('조회 연산 오류');
        const query = count => ({ get: async () => ({ docs: Object.keys(cards)
          .filter(id => cards[id][field].includes(value)).slice(0, count).map(snapshot) }) });
        return { ...query(), limit: query };
      } };
    },
    getAll: async (...refs) => refs.map(ref => snapshot(ref.id)),
  };
  return { db, resources: {
    getBucket: () => ({ name: 'demo-card-assets', file: name => ({ getMetadata: async () => {
      if (!['public/cardNames.json', 'public/packs.json', 'public/rarityMapping.json'].includes(name)) throw new Error('카드 이외 파일 접근 금지');
      return [{ generation: '9007199254740993', updated: '2026-01-01T00:00:00Z' }];
    } }) }),
    isEmulator: () => false, getStorageEmulatorBaseUrl: () => '',
  } };
}
module.exports = { createFixtureBackend };
