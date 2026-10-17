const { forwardAdminRequest } = require('../services/adminActionTransport');
const { onRequest } = require("firebase-functions/v2/https");
const { db } = require("../config/firebase");
const { setCors, verifyAppCheck, verifyAdmin } = require("../utils/auth");
const { safeErrorSummary } = require("../utils/safeError");
const sheets = require("../integrations/googleSheets");

exports.checkSheet = onRequest({ invoker: "public" }, async (req, res) => {
  setCors(res, req);
  res.set('Cache-Control', 'no-store');
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'GET 요청만 지원합니다.' });
  if (!(await verifyAppCheck(req, res))) return;

  const id = req.query.targetId;
  if (!sheets.sheetsIsValidSpreadsheetId(id)) return res.status(400).json({ success: false, message: '올바른 시트 ID가 필요합니다.' });

  try {
    const { migrationFetchPublicMyCardData } = require("../services/migrationService");
    const preview = await migrationFetchPublicMyCardData(id);
    return res.json({ status: 'OK', sheetName: 'MyCard', rowCount: preview.data.length,
      totalQty: preview.totalQty, skippedZeroCount: preview.skippedZeroCount,
      legacyQuantity: preview.legacyQuantity, fingerprint: preview.fingerprint });
  } catch (err) {
    console.error("checkSheet error:", safeErrorSummary(err));
    if (err.code === 'INVALID_IMPORT') return res.json({ status: 'INVALID_DATA', message: err.message });
    if (err.code === 'PUBLIC_SHEET_NO_ACCESS') return res.json({ status: 'NO_ACCESS' });
    return res.status(503).json({ success: false, message: '시트를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.' });
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
  // 명시적으로 허용한 legacy 경로 외에는 설정을 먼저 검사한다.
  // 잘못된 backend·로컬 RTDB가 기존 운영 관리자 proxy로 전달되지 않게 한다.
  if (process.env.USER_PROFILE_WRITER_MODE === 'production' || process.env.USER_STORAGE_MODE === 'production') {
    if (await forwardAdminRequest(req, res, 'uploadMembershipCsv')) return;
    return res.status(503).json({ success: false });
  }
  if (process.env.USER_PROFILE_WRITER_MODE) return res.status(503).json({ success: false });
  const backend = process.env.USER_STORAGE_BACKEND;
  if (![undefined, '', 'storage'].includes(backend)) {
    if (backend !== 'rtdb') return res.status(503).json({ success: false });
    try {
      if (require('../config/userStorage').resolveUserStorageConfig().mode !== 'production') throw Error('isolated runtime');
    } catch (_) { return res.status(503).json({ success: false }); }
  }
  if (await forwardAdminRequest(req, res, 'uploadMembershipCsv')) return;
  if (req.method !== 'POST') return res.status(405).json({ success: false });
  const access = await verifyAdmin(req, res);
  if (!access) return;
  try {
    const { randomBytes } = require('node:crypto');
    const { createMembershipCsvService } = require('../services/membershipCsvService');
    const { getMembershipCsvStore } = require('../services/membershipCsvRepository');
    const service = createMembershipCsvService({ store: getMembershipCsvStore({ db }) });
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
