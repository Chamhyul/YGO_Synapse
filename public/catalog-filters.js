/* 검색의 적용 상태·메타데이터 판정. 화면/모달 및 원본 저장값에 의존하지 않는다. */
const CatalogFilters = (() => {
    const choices = (ids, labels, codes = ids.map((_, index) => index)) => ids.map((value, index) => ({ value, label: labels[index], code: codes[index] }));
    const kinds = choices(['monster', 'spell', 'trap'], ['몬스터', '마법', '함정']);
    const properties = {
        monster: choices(['normal', 'effect', 'ritual', 'fusion', 'synchro', 'xyz', 'pendulum', 'link', 'toon', 'spirit', 'union', 'gemini', 'tuner', 'flip', 'special'],
            ['일반', '효과', '의식', '융합', '싱크로', '엑시즈', '펜듈럼', '링크', '툰', '스피릿', '유니온', '듀얼', '튜너', '리버스', '특수 소환'],
            [0, 1, 2, 3, 4, 5, 6, 13, 8, 7, 10, 11, 9, 12, 14]),
        spell: choices(['normal', 'equip', 'field', 'quick', 'ritual', 'continuous'], ['일반', '장착', '필드', '속공', '의식', '지속'], [15, 19, 18, 17, 20, 16]),
        trap: choices(['normal', 'continuous', 'counter'], ['일반', '지속', '카운터'], [21, 22, 23])
    };
    // 사용자 지정 순서와 저장 코드의 순서는 별개다.
    const attributes = choices(['dark', 'light', 'earth', 'water', 'fire', 'wind', 'divine'], ['어둠', '빛', '땅', '물', '화염', '바람', '신']);
    const races = choices(['spellcaster', 'dragon', 'zombie', 'warrior', 'beast-warrior', 'beast', 'winged-beast', 'fiend', 'fairy', 'insect', 'dinosaur', 'reptile', 'fish', 'sea-serpent', 'aqua', 'pyro', 'thunder', 'rock', 'plant', 'machine', 'psychic', 'wyrm', 'cyberse', 'illusion', 'divine-beast', 'creator-god'],
        ['마법사족', '드래곤족', '언데드족', '전사족', '야수전사족', '야수족', '비행야수족', '악마족', '천사족', '곤충족', '공룡족', '파충류족', '어류족', '해룡족', '물족', '화염족', '번개족', '암석족', '식물족', '기계족', '사이킥족', '환룡족', '사이버스족', '환상마족', '환신야수족', '창조신족'],
        [17, 0, 1, 14, 11, 10, 15, 2, 16, 9, 8, 19, 7, 4, 13, 3, 18, 5, 12, 6, 22, 23, 24, 25, 21, 20]);
    const definitions = {
        target: { label: '검색 대상', options: choices(['name', 'number'], ['이름', '번호']) },
        kind: { label: '종류', options: kinds },
        monster: { label: '몬스터 특성', options: properties.monster, characteristic: true, kind: 'monster' },
        spell: { label: '마법 특성', options: properties.spell, characteristic: true, kind: 'spell' },
        trap: { label: '함정 특성', options: properties.trap, characteristic: true, kind: 'trap' },
        attribute: { label: '속성', options: attributes, kind: 'monster' },
        race: { label: '종족', options: races, kind: 'monster' },
        level: { label: '레벨 / 랭크 / 링크', numeric: 'exact', kind: 'monster' },
        pendulum: { label: '펜듈럼', numeric: 'exact', kind: 'monster' },
        attack: { label: '공격력', numeric: 'range', kind: 'monster' },
        defense: { label: '수비력', numeric: 'range', kind: 'monster' }
    };
    const keys = Object.keys(definitions);
    const clone = value => JSON.parse(JSON.stringify(value));
    const emptyValue = key => definitions[key].characteristic ? { values: [], operator: 'or' }
        : definitions[key].numeric === 'range' ? { from: null, to: null }
        : definitions[key].numeric ? null : [];
    function create(searchTarget = 'auto') {
        const result = Object.fromEntries(keys.map(key => [key, emptyValue(key)]));
        result.target = ['name', 'number'].includes(searchTarget) ? [searchTarget] : [];
        return result;
    }
    const selectedKinds = filters => filters.kind.length ? filters.kind : kinds.map(item => item.value);
    const isEnabled = (filters, key) => !definitions[key]?.kind || selectedKinds(filters).includes(definitions[key].kind);
    const isActive = (filters, key) => {
        const value = filters[key];
        if (definitions[key].characteristic) return value.values.length > 0;
        if (definitions[key].numeric === 'range') return value.from !== null || value.to !== null;
        if (definitions[key].numeric) return value !== null;
        return value.length > 0;
    };
    const needsMetadata = filters => keys.some(key => key !== 'target' && isEnabled(filters, key) && isActive(filters, key));
    const storedKinds = ['Monster', 'Spell', 'Trap'];
    const storedAttributes = ['DARK', 'LIGHT', 'EARTH', 'WATER', 'FIRE', 'WIND', 'DIVINE'];
    const storedRaces = ['Dragon', 'Zombie', 'Fiend', 'Pyro', 'Sea Serpent', 'Rock', 'Machine', 'Fish', 'Dinosaur', 'Insect', 'Beast', 'Beast-Warrior', 'Plant', 'Aqua', 'Warrior', 'Winged Beast', 'Fairy', 'Spellcaster', 'Thunder', 'Reptile', 'Creator God', 'Divine-Beast', 'Psychic', 'Wyrm', 'Cyberse', 'Illusion'];
    const storedProperties = ['Normal', 'Effect', 'Ritual', 'Fusion', 'Synchro', 'Xyz', 'Pendulum', 'Spirit', 'Toon', 'Tuner', 'Union', 'Gemini', 'Flip', 'Link', 'Special Summon', 'Normal Spell', 'Continuous Spell', 'Quick-Play Spell', 'Field Spell', 'Equip Spell', 'Ritual Spell', 'Normal Trap', 'Continuous Trap', 'Counter Trap'];
    const readCode = (value, stored) => value === null || value === undefined || value === '' ? -1
        : typeof value === 'string' && !/^\d+$/.test(value) ? stored.indexOf(value) : Number(value);
    const scalar = (value, unknownAsZero = false) => {
        if (unknownAsZero && (value === '?' || value === -1 || value === '-1')) return 0;
        if (value === null || value === undefined || value === '' || value === '-') return null;
        const number = Number(value);
        return Number.isFinite(number) && number >= 0 ? number : null;
    };
    function normalize(meta, { complete = true } = {}) {
        const info = meta?.info || meta?.rawSlot || meta;
        if (!info || typeof info !== 'object') return null;
        const kindCode = readCode(info[10] ?? info.card_type, storedKinds);
        const kind = kinds.find(choice => choice.code === kindCode)?.value;
        if (!kind) return null;
        const rawProperties = info[11] ?? info.properties;
        const codes = Array.isArray(rawProperties) ? rawProperties.map(value => readCode(value, storedProperties)) : [];
        const propertyValues = properties[kind].filter(option => codes.includes(option.code)).map(option => option.value);
        const read = (slot, name, convert) => Object.hasOwn(info, slot) || Object.hasOwn(info, name)
            ? convert(info[slot] ?? info[name]) : complete ? null : undefined;
        const knownProperties = rawProperties !== undefined || complete;
        return {
            kind, properties: knownProperties ? propertyValues : undefined,
            attribute: read(13, 'attribute', value => attributes.find(item => item.code === readCode(value, storedAttributes))?.value ?? null),
            race: read(14, 'race', value => races.find(item => item.code === readCode(value, storedRaces))?.value ?? null),
            level: read(12, 'lv', scalar),
            pendulum: knownProperties && !propertyValues.includes('pendulum') ? null : read(17, 'pendulum_scale', scalar),
            attack: read(15, 'atk', value => scalar(value, true)),
            defense: propertyValues.includes('link') ? null : read(16, 'def', value => scalar(value, true))
        };
    }
    function evaluate(card, filters, meta) {
        if (filters.target.length && !filters.target.some(value => value === 'name' ? card.nameMatch : card.numberMatch)) return 'miss';
        if (!needsMetadata(filters)) return 'match';
        if (!meta) return 'pending';
        if (!selectedKinds(filters).includes(meta.kind)) return 'miss';
        const characteristic = filters[meta.kind];
        if (characteristic.values.length) {
            if (meta.properties === undefined) return 'pending';
            const predicate = value => meta.properties.includes(value);
            if (!(characteristic.operator === 'and' ? characteristic.values.every(predicate) : characteristic.values.some(predicate))) return 'miss';
        }
        if (meta.kind !== 'monster') return 'match';
        for (const key of ['attribute', 'race']) {
            if (filters[key].length && meta[key] === undefined) return 'pending';
            if (filters[key].length && !filters[key].includes(meta[key])) return 'miss';
        }
        for (const key of ['level', 'pendulum']) {
            if (filters[key] !== null && meta[key] === undefined) return 'pending';
            if (filters[key] !== null && meta[key] !== filters[key]) return 'miss';
        }
        for (const key of ['attack', 'defense']) {
            const { from, to } = filters[key];
            if (from === null && to === null) continue;
            if (meta[key] === undefined) return 'pending';
            if (meta[key] === null || (from !== null && meta[key] < from) || (to !== null && meta[key] > to)) return 'miss';
        }
        return 'match';
    }
    function validate(key, value) {
        const definition = definitions[key];
        if (!definition) return { error: '알 수 없는 필터입니다.' };
        if (!definition.numeric) {
            const values = definition.characteristic ? value.values : value;
            if (!Array.isArray(values) || values.some(item => !definition.options.some(option => option.value === item))) return { error: '선택값을 확인해 주세요.' };
            return { value: definition.characteristic ? { values: [...new Set(values)], operator: value.operator === 'and' ? 'and' : 'or' } : [...new Set(values)] };
        }
        const parse = input => {
            if (input === null || input === undefined || String(input).trim() === '') return { value: null };
            if (!/^\d+$/.test(String(input).trim())) return { error: '0 이상의 정수를 입력해 주세요.' };
            const number = Number(input);
            if (!Number.isSafeInteger(number)) return { error: '정확히 표시할 수 있는 정수를 입력해 주세요.' };
            return { value: number };
        };
        if (definition.numeric === 'exact') {
            const parsed = parse(value);
            if (parsed.error) return parsed;
            return parsed.value !== null && parsed.value > 13 ? { error: '0부터 13까지의 정수를 입력해 주세요.' } : parsed;
        }
        const from = parse(value.from), to = parse(value.to);
        if (from.error || to.error) return { error: from.error || to.error };
        if (from.value !== null && to.value !== null && from.value > to.value) return { error: '시작값은 끝값보다 클 수 없습니다.' };
        return { value: { from: from.value, to: to.value } };
    }
    function summarize(filters, key) {
        const definition = definitions[key], value = filters[key];
        if (definition.numeric === 'range') return !isActive(filters, key) ? '설정 없음' : `${value.from ?? '제한 없음'} ~ ${value.to ?? '제한 없음'}`;
        if (definition.numeric) return value === null ? '설정 없음' : String(value);
        const values = definition.characteristic ? value.values : value;
        const summary = !values.length ? (['target', 'kind'].includes(key) ? '전체' : '설정 없음')
            : values.length === definition.options.length ? '전체'
            : definition.options.filter(option => values.includes(option.value)).map(option => option.label).join(', ');
        return definition.characteristic ? `${value.operator.toUpperCase()}: ${summary}` : summary;
    }
    return { definitions, keys, kinds, create, clone, emptyValue, isEnabled, isActive, selectedKinds, normalize, evaluate, validate, summarize };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = CatalogFilters;
