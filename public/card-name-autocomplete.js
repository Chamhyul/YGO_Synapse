(function (root) {
    'use strict';
    const initials = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
    // 중성 인덱스. 두벌식에서 한 키를 더 눌러 완성할 수 있는 겹모음입니다.
    const medialExtensions = { 8: [9, 10, 11], 13: [14, 15, 16], 18: [19] };
    const normalize = value => value.normalize('NFC').replace(/\s+/gu, '').toLowerCase();
    const isOpenSyllable = point => point >= 0xac00 && point <= 0xd7a3 && (point - 0xac00) % 28 === 0;
    const range = (start, end) => String.fromCodePoint(start) + '-' + String.fromCodePoint(end);

    function variants(query) {
        const last = query.at(-1)?.codePointAt(0);
        if (!isOpenSyllable(last)) return [query];
        const medial = ((last - 0xac00) / 28) % 21;
        return [query, ...(medialExtensions[medial] || []).map(next =>
            query.slice(0, -1) + String.fromCodePoint(last + (next - medial) * 28))];
    }

    function pattern(query, continuations = [query]) {
        return [...query].map((char, index, chars) => {
            const initial = initials.indexOf(char), point = char.codePointAt(0);
            if (initial >= 0) {
                const start = 0xac00 + initial * 588;
                return '[' + range(start, start + 587) + ']';
            }
            if (index === chars.length - 1 && isOpenSyllable(point)) {
                return '[' + continuations.map(value => {
                    const start = value.at(-1).codePointAt(0);
                    return range(start, start + 27);
                }).join('') + ']';
            }
            return char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        }).join('');
    }

    const api = { initials, normalize, isOpenSyllable, variants, pattern };
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.YgoCardNameAutocomplete = api;
})(globalThis);
