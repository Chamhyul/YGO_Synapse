const { resolveInventoryCid, getCardByCid, normalizeNumber, mapLimited } = require('./cardQueryService');
const { normalizeText } = require('../utils/common');
const { setTimeout, clearTimeout } = require('node:timers');
const RETRY_MS = 24 * 60 * 60 * 1000;
const BATCH_SIZE = 40;
const validCid = value => typeof value === 'string' && value.length > 0 &&
  !['LOCAL_CID', 'MISSING_CID', 'null', 'undefined'].includes(value) && !value.includes('/');

async function resolveBeforeDeadline(number, name, remainingMs) {
  let timer;
  try {
    return await Promise.race([
      resolveInventoryCid(number, name),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('CID 조회 시간 초과'),
          { code: 'CID_LOOKUP_TIMEOUT' })), Math.max(1, remainingMs));
      }),
    ]);
  } finally { clearTimeout(timer); }
}

function inventoryMigrationStatus(inventory) {
  const entries = Object.values(inventory.cards || {});
  const pendingCount = entries.filter(entry => !validCid(entry.cid) &&
    !(entry.cid === null && entry.cidCheckedAt)).length;
  const unresolvedCount = entries.filter(entry => !validCid(entry.cid)).length;
  const retryAt = inventory.cidMigration?.retryAt || 0;
  const retryableError = inventory.cidMigration?.retryableError === true;
  const retryPending = entries.some(entry => entry.cid === null && entry.cidCheckedAt &&
    Date.now() - entry.cidCheckedAt >= RETRY_MS);
  return { status: retryableError ? 'retryableError' : pendingCount || retryPending ? 'pending' : 'complete',
    pendingCount, unresolvedCount, retryAt };
}

// 조회 성공과 미발견을 구분해 기록합니다. 실패한 항목은 완료 처리하지 않습니다.
async function prepareInventoryV2(inventory, memo = new Map()) {
  if (Number(inventory.version || 1) > 2) throw new Error('지원하지 않는 인벤토리 버전입니다.');
  inventory.cards ||= {};
  const now = Date.now();
  if ((inventory.cidMigration?.retryAt || 0) > now) return;
  const candidates = Object.entries(inventory.cards).filter(([, entry]) =>
    !validCid(entry.cid) && (entry.cid !== null || !entry.cidCheckedAt || now - entry.cidCheckedAt >= RETRY_MS));
  // 신규/미처리 항목을 먼저 처리한 후 미확정 항목을 다시 확인합니다.
  candidates.sort((a, b) => (a[1].cidCheckedAt || 0) - (b[1].cidCheckedAt || 0));
  let failed = false;
  await mapLimited(candidates.slice(0, BATCH_SIZE), async ([number, entry]) => {
    if (Date.now() - now > 12000) return;
    const key = JSON.stringify([number, entry.name]);
    try {
      if (!memo.has(key)) memo.set(key, await resolveBeforeDeadline(number, entry.name, 12000 - (Date.now() - now)));
      entry.cid = memo.get(key);
      entry.cidCheckedAt = Date.now();
    } catch (error) {
      failed = true;
      console.warn('[InventoryV2] CID 조회 재시도:', error.code || error.message);
    }
  });
  inventory.version = inventoryMigrationStatus(inventory).pendingCount ? 1 : 2;
  if (failed) inventory.cidMigration = { retryableError: true, retryAt: Date.now() + 30000 };
  else if (inventory.cidMigration) delete inventory.cidMigration;
}

async function ensureInventoryV2(uid) {
  const { updateInventoryWithRetry } = require('../utils/inventoryStorage');
  return updateInventoryWithRetry(uid, () => {});
}

async function resolveGroupCids(groups) {
  await mapLimited(Object.entries(groups), async ([number, group]) => {
    if (validCid(group.requestedCid)) {
      const card = await getCardByCid(group.requestedCid);
      if (card && (card.data.numbers || []).some(no => normalizeNumber(no) === normalizeNumber(number)) &&
          (card.data.names || []).some(name => normalizeText(name) === normalizeText(group.name))) {
        group.cid = card.cid;
        return;
      }
    }
    group.cid = await resolveInventoryCid(number, group.name);
  });
}

module.exports = { prepareInventoryV2, ensureInventoryV2, resolveGroupCids, inventoryMigrationStatus };
