const { forwardAdminRequest } = require('../services/adminActionTransport');
const { onRequest } = require("firebase-functions/v2/https");
const { db } = require("../config/firebase");
const { setCors, verifyAppCheck, verifyAdmin } = require("../utils/auth");
const { safeErrorSummary } = require("../utils/safeError");
const sheets = require("../integrations/googleSheets");

exports.checkSheet = onRequest({ invoker: "public" }, async (req, res) => {
  setCors(res, req);
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (!(await verifyAppCheck(req, res))) return;

  const id = req.query.targetId;
  if (!id) return res.status(400).json({ success: false, message: "Missing Spreadsheet ID" });

  try {
    const metadata = await sheets.getSpreadsheetMetadata(id);
    const { fetchMyCardData_Node } = require("../services/migrationService");
    const preview = await fetchMyCardData_Node(id);
    return res.json({ status: 'OK', sheetName: metadata.properties.title, rowCount: preview.data.length,
      totalQty: preview.totalQty, skippedZeroCount: preview.skippedZeroCount,
      legacyQuantity: preview.legacyQuantity, fingerprint: preview.fingerprint });
  } catch (err) {
    console.error("checkSheet error:", safeErrorSummary(err));
    if (err.code === 'INVALID_IMPORT') return res.json({ status: 'INVALID_DATA', message: err.message });
    return res.json({ status: 'NO_ACCESS' });
  }
});

// 구버전의 state 없는 Discord 인증 경로는 저장 없이 차단한다.
exports.checkMembershipDiscord = onRequest({ invoker: 'public' }, async (req, res) => {
  setCors(res, req);
  res.set('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).send('');
  return res.status(410).json({ success: false, code: 'DISCORD_PROOF_REQUIRED',
    message: '새로고침 후 Discord 인증을 다시 진행해 주세요.' });
});

// 구버전의 임의 채널 ID 제출 경로는 회원 상태를 변경하지 않는다.
exports.checkMembershipCsv = onRequest({ invoker: "public" }, async (req, res) => {
  setCors(res, req);
  res.set('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).send('');
  return res.status(410).json({ success: false, code: 'YOUTUBE_PROOF_REQUIRED',
    message: '새로고침 후 YouTube 인증을 다시 진행해 주세요.' });
});

/** 기존 외부 함수명은 유지하고 관리자 화면과 같은 검증·목록 전환을 사용한다. */
exports.uploadMembershipCsv = onRequest({ invoker: 'public', timeoutSeconds: 60 }, async (req, res) => {
  setCors(res, req);
  res.set('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (await forwardAdminRequest(req, res, 'uploadMembershipCsv')) return;
  if (req.method !== 'POST') return res.status(405).json({ success: false });
  const access = await verifyAdmin(req, res);
  if (!access) return;
  try {
    const { randomBytes } = require('node:crypto');
    const { createMembershipCsvService, createFirestoreMembershipCsvStore } = require('../services/membershipCsvService');
    const service = createMembershipCsvService({ store: createFirestoreMembershipCsvStore(db) });
    const preview = await service.preview(req.body);
    const result = await service.apply({ ...req.body, ...preview, operationId: req.body?.operationId || randomBytes(16).toString('hex') }, access.uid);
    return res.json({ success: true, ...result });
  } catch (error) {
    const expected = typeof error.code === 'string' && error.code.startsWith('MEMBERSHIP_CSV_');
    if (!expected) console.error('uploadMembershipCsv error:', safeErrorSummary(error));
    return res.status(expected ? error.status : 503).json({ success: false,
      message: expected ? error.message : '멤버십 목록 적용 결과를 확인하지 못했습니다.' });
  }
});
