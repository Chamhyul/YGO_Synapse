/* 파일 입출력·가져온 추가량 집계. 인증·저장·화면 수명주기는 호출자가 관리한다. */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.AppDataTransfer = api;
})(typeof window === 'object' ? window : globalThis, function () {
    'use strict';
    const headers = ['카드 이름', '카드 번호', '레어도', '수량', '보관 위치', '일러스트'];
    const required = headers.filter(name => name !== '수량');
    const text = value => String(value ?? '').trim();

    function parseCsv(input) {
        const source = String(input).replace(/^\uFEFF/, '');
        const rows = [];
        let row = [], field = '', quoted = false, endedQuote = false;
        const cell = () => { row.push(field); field = ''; endedQuote = false; };
        const line = () => { cell(); rows.push(row); row = []; };
        for (let index = 0; index < source.length; index++) {
            const ch = source[index];
            if (quoted) {
                if (ch !== '"') field += ch;
                else if (source[index + 1] === '"') { field += '"'; index++; }
                else { quoted = false; endedQuote = true; }
            } else if (ch === ',') cell();
            else if (ch === '\r' || ch === '\n') {
                line();
                if (ch === '\r' && source[index + 1] === '\n') index++;
            } else if (ch === '"' && field === '' && !endedQuote) quoted = true;
            else if (endedQuote && /[ \t]/.test(ch)) continue;
            else if (endedQuote || ch === '"') throw new Error('CSV 따옴표 형식이 올바르지 않습니다.');
            else field += ch;
        }
        if (quoted) throw new Error('CSV의 닫히지 않은 따옴표를 확인해주세요.');
        if (field || row.length || endedQuote) line();
        return rows;
    }

    function parseRows(rows) {
        if (!Array.isArray(rows) || !rows.length) throw new Error('데이터가 없는 빈 파일입니다.');
        const names = rows[0].map(value => text(value).replace(/^\uFEFF/, ''));
        const missing = required.filter(name => !names.includes(name));
        if (missing.length) throw new Error(`필수 항목이 누락되었습니다: ${missing.join(', ')}`);
        for (const name of headers) {
            if (names.indexOf(name) !== names.lastIndexOf(name)) throw new Error(`중복된 열을 확인해주세요: ${name}`);
        }
        const column = Object.fromEntries(headers.map(name => [name, names.indexOf(name)]));
        const legacyQuantity = column['수량'] < 0;
        const data = [];
        let skippedZeroCount = 0, totalQty = 0;
        rows.slice(1).forEach((row, index) => {
            if (!row.some(value => text(value) !== '')) return;
            const value = legacyQuantity ? 1 : row[column['수량']];
            const qty = typeof value === 'number' ? value : /^\d+$/.test(text(value)) ? Number(text(value)) : NaN;
            if (!Number.isSafeInteger(qty) || qty < 0) throw new Error(`${index + 2}행의 수량은 0 이상의 정수여야 합니다. 빈값·음수·소수·문자는 사용할 수 없습니다.`);
            if (qty === 0) { skippedZeroCount++; return; }
            const name = text(row[column['카드 이름']]);
            const no = text(row[column['카드 번호']]).toUpperCase();
            if (!name || !no) throw new Error(`${index + 2}행의 카드 이름과 카드 번호를 확인해주세요.`);
            totalQty += qty;
            if (!Number.isSafeInteger(totalQty)) throw new Error('총수량이 지원 범위를 초과했습니다.');
            data.push({ name, no, rare: text(row[column['레어도']]) || '기본', qty,
                loc: text(row[column['보관 위치']]) || '미보관', illust: text(row[column['일러스트']]) || '1' });
        });
        if (!data.length) throw new Error(skippedZeroCount ? `가져올 카드가 없습니다. 수량 0인 ${skippedZeroCount}개 행을 제외했습니다.` : '가져올 카드가 없습니다.');
        return { data, legacyQuantity, skippedZeroCount, totalQty };
    }

    function summarize(items) {
        const groups = new Map();
        let totalQty = 0;
        for (const item of items) {
            const qty = Number(item.qty);
            if (!Number.isSafeInteger(qty) || qty <= 0) throw new Error('가져오기 결과의 수량을 확인할 수 없습니다.');
            const key = item.cid ? `cid:${item.cid}` : `name:${item.name}`;
            if (!groups.has(key)) groups.set(key, { name: item.name, qty: 0 });
            groups.get(key).qty += qty;
            totalQty += qty;
        }
        const summary = [...groups.values()];
        return { items, summary: summary.slice(0, 5), cardCount: groups.size, totalQty,
            restQty: summary.slice(5).reduce((sum, item) => sum + item.qty, 0) };
    }

    function toCsv(rows) {
        const escape = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
        return '\uFEFF' + headers.join(',') + '\r\n' + rows.map(row =>
            [row[0], row[1], row[2], row[3], row[4], row[5] || '1'].map(escape).join(',')).join('\r\n');
    }
    return { parseCsv, parseRows, summarize, toCsv };
});
