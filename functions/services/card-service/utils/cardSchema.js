// Firestore 저장 구조. 숫자 슬롯은 크롤러/화면 내부 형식으로만 사용합니다.
const LOCALES = ['ko', 'ja', 'ae', 'cn', 'en', 'de', 'fr', 'it', 'es', 'pt'];
const KINDS = ['Monster', 'Spell', 'Trap'];
const ATTRIBUTES = ['DARK', 'LIGHT', 'EARTH', 'WATER', 'FIRE', 'WIND', 'DIVINE'];
const RACES = ['Dragon', 'Zombie', 'Fiend', 'Pyro', 'Sea Serpent', 'Rock', 'Machine', 'Fish', 'Dinosaur', 'Insect', 'Beast', 'Beast-Warrior', 'Plant', 'Aqua', 'Warrior', 'Winged Beast', 'Fairy', 'Spellcaster', 'Thunder', 'Reptile', 'Creator God', 'Divine-Beast', 'Psychic', 'Wyrm', 'Cyberse', 'Illusion'];
const MONSTER_TYPES = ['Normal', 'Effect', 'Ritual', 'Fusion', 'Synchro', 'Xyz', 'Pendulum', 'Spirit', 'Toon', 'Tuner', 'Union', 'Gemini', 'Flip', 'Link', 'Special Summon'];
const PROPERTIES = [...MONSTER_TYPES, 'Normal Spell', 'Continuous Spell', 'Quick-Play Spell', 'Field Spell', 'Equip Spell', 'Ritual Spell', 'Normal Trap', 'Continuous Trap', 'Counter Trap'];

function toStoredInfo(info = {}) {
  const result = {};
  for (const [key, value] of Object.entries(info)) {
    if (/^\d+$/.test(key) && Number(key) > 17) throw new Error(`알 수 없는 카드 필드: ${key}`);
    if (!/^\d+$/.test(key) && value !== undefined && value !== null) result[key] = value;
  }
  LOCALES.forEach((locale, index) => {
    const slot = info[locale] || info[index];
    if (!slot) return;
    if (!Array.isArray(slot)) { result[locale] = { ...slot }; return; }
    result[locale] = {
      name: slot[0] || '',
      // 종수만으로는 실제 ciid를 복원할 수 없습니다. 재수집 전에는 미확정(null).
      ciid: Array.isArray(slot[1]) ? slot[1] : null,
      packs: slot[2] || {}, text: slot[3] || '', text_pen: slot[4] || '',
    };
  });
  if (info[10] != null) result.card_type = KINDS[info[10]];
  if (info[11] != null) {
    result.properties = info[11].map(i => PROPERTIES[i]);
  }
  if (info[12] != null) {
    result.lv = info[12];
  }
  if (info[13] != null) result.attribute = ATTRIBUTES[info[13]];
  if (info[14] != null) result.race = RACES[info[14]];
  for (const [index, key] of [[15, 'atk'], [16, 'def'], [17, 'pendulum_scale']]) {
    if (info[index] != null) result[key] = info[index] === -1 ? '?' : info[index];
  }
  for (const [key, value] of Object.entries(result)) {
    if (value === undefined || (Array.isArray(value) && value.some(v => v === undefined))) {
      throw new Error(`알 수 없는 카드 분류 코드: ${key}`);
    }
  }
  return result;
}

function toRuntimeInfo(info = {}) {
  const result = {};
  for (const [key, value] of Object.entries(info)) if (/^\d+$/.test(key)) result[key] = value;
  LOCALES.forEach((locale, index) => {
    const slot = info[locale];
    if (slot) result[index] = [slot.name, slot.ciid || [], slot.packs || {}, slot.text || '', slot.text_pen || ''];
  });
  if (info.card_type != null) result[10] = KINDS.indexOf(info.card_type);
  if (info.properties) result[11] = info.properties.map(value => PROPERTIES.indexOf(value));
  if (info.lv != null) result[12] = info.lv;
  if (info.attribute != null) result[13] = ATTRIBUTES.indexOf(info.attribute);
  if (info.race != null) result[14] = RACES.indexOf(info.race);
  for (const [index, key] of [[15, 'atk'], [16, 'def'], [17, 'pendulum_scale']]) {
    if (info[key] != null) result[index] = info[key] === '?' ? -1 : info[key];
  }
  return result;
}

module.exports = { LOCALES, toStoredInfo, toRuntimeInfo };
