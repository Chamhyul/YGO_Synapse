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

/**
 * 유튜브 스튜디오 멤버십 CSV 텍스트 파서
 */
function parseYoutubeMembersCsv(csvText) {
  const lines = csvText.split(/\r?\n/).filter(line => line.trim().length > 0);
  if (lines.length === 0) return [];

  const parseCsvLine = (line) => {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        result.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    result.push(current.trim());
    return result;
  };

  const header = parseCsvLine(lines[0]);
  const nameIdx = header.findIndex(h => h.includes("회원"));
  const urlIdx = header.findIndex(h => h.includes("프로필") || h.includes("연결"));
  const levelIdx = header.findIndex(h => h.includes("현재") || h.includes("등급"));

  const members = [];
  for (let i = 1; i < lines.length; i++) {
    const row = parseCsvLine(lines[i]);
    if (row.length < 2) continue;

    const profileUrl = urlIdx !== -1 ? row[urlIdx] : "";
    const memberName = nameIdx !== -1 ? row[nameIdx] : "";
    const levelName = levelIdx !== -1 ? row[levelIdx] : "";

    // URL에서 Channel ID 추출 (/channel/UC...)
    const match = profileUrl.match(/channel\/(UC[a-zA-Z0-9_-]+)/);
    const channelId = match ? match[1] : null;

    if (channelId) {
      members.push({
        channelId,
        memberName,
        levelName: levelName || "유튜브 멤버십"
      });
    }
  }

  return members;
}

// [관리자] 멤버십 CSV 회원 목록 일괄 업로드 (원시 CSV 텍스트 또는 파싱된 배열 모두 지원)
exports.uploadMembershipCsv = onRequest({
  invoker: "public"
}, async (req, res) => {
  setCors(res, req);
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (await forwardAdminRequest(req, res, 'uploadMembershipCsv')) return;
  if (req.method !== 'POST') return res.status(405).json({ success: false });

  if (!(await verifyAdmin(req, res))) return;

  let members = [];
  
  if (req.body && req.body.csvText) {
    // 원시 CSV 파일 텍스트를 전달받은 경우 자동 파싱
    members = parseYoutubeMembersCsv(req.body.csvText);
  } else if (req.body && Array.isArray(req.body.members)) {
    // 이미 파싱된 배열을 전달받은 경우
    members = req.body.members;
  } else {
    return res.status(400).json({ success: false, message: "csvText 또는 members 배열 데이터가 필요합니다." });
  }

  if (members.length === 0) {
    return res.status(400).json({ success: false, message: "파싱 가능한 멤버십 회원 데이터가 없습니다." });
  }

  try {
    // 1. 기존 membership_csv_users 컬렉션 청크 삭제 (500개 제약 대비)
    const snapshot = await db.collection("membership_csv_users").get();
    if (!snapshot.empty) {
      const docs = snapshot.docs;
      const CHUNK_SIZE = 450;
      for (let i = 0; i < docs.length; i += CHUNK_SIZE) {
        const deleteBatch = db.batch();
        docs.slice(i, i + CHUNK_SIZE).forEach(doc => deleteBatch.delete(doc.ref));
        await deleteBatch.commit();
      }
    }

    // 2. 신규 CSV 멤버십 회원 청크 일괄 등록 (500개 제약 대비)
    const now = Date.now();
    const validMembers = members.filter(m => m.channelId);
    const CHUNK_SIZE = 450;

    for (let i = 0; i < validMembers.length; i += CHUNK_SIZE) {
      const batch = db.batch();
      const chunk = validMembers.slice(i, i + CHUNK_SIZE);
      chunk.forEach(item => {
        const ref = db.collection("membership_csv_users").doc(item.channelId);
        batch.set(ref, {
          channelId: item.channelId,
          memberName: item.memberName || "",
          levelName: item.levelName || "유튜브 멤버십",
          updatedAt: now
        });
      });
      await batch.commit();
    }

    return res.json({ success: true, count: validMembers.length, sample: validMembers.slice(0, 3) });

  } catch (err) {
    console.error("uploadMembershipCsv error:", safeErrorSummary(err));
    return res.status(500).json({ success: false, message: "멤버십 CSV 업로드에 실패했습니다. 잠시 후 다시 시도해 주세요." });
  }
});
