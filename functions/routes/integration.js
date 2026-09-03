const { onRequest } = require("firebase-functions/v2/https");
const { 
  db,
  admin,
  GOOGLE_CLIENT_ID, 
  GOOGLE_CLIENT_SECRET, 
  GOOGLE_REFRESH_TOKEN,
  DISCORD_BOT_TOKEN,
  DISCORD_CLIENT_SECRET,
  DISCORD_CLIENT_ID,
  DISCORD_GUILD_ID,
  DISCORD_ROLE_ID
} = require("../config/firebase");
const { google } = require("googleapis");
const { setCors, verifyAppCheck, verifyUser } = require("../utils/auth");
const sheets = require("../integrations/googleSheets");
const { getDiscordUserWithCode, checkGuildMemberRole } = require("../integrations/discord");

exports.checkSheet = onRequest({ invoker: "public" }, async (req, res) => {
  setCors(res, req);
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (!(await verifyAppCheck(req, res))) return;

  const id = req.query.targetId;
  if (!id) return res.status(400).json({ success: false, message: "Missing Spreadsheet ID" });

  try {
    const metadata = await sheets.getSpreadsheetMetadata(id);
    return res.json({ status: 'OK', sheetName: metadata.properties.title });
  } catch (err) {
    console.error("checkSheet error:", err);
    return res.json({ status: 'NO_ACCESS' });
  }
});

/**
 * 유저 계정의 최상위 권한(owner/admin/none)을 Firebase Auth Custom Claims 기반 단독 조회
 */
async function getUserRoleFromAuth(uid) {
  try {
    const authUser = await admin.auth().getUser(uid);
    const claims = authUser.customClaims || {};
    if (claims.role === "owner") return "owner";
    if (claims.role === "admin" || claims.admin === true) return "admin";
    return "none";
  } catch (e) {
    console.error("getUserRoleFromAuth error:", e);
    return "none";
  }
}

// [메인] 디스코드 서버 역할 기반 멤버십 검증
exports.checkMembershipDiscord = onRequest({
  invoker: "public",
  secrets: [DISCORD_BOT_TOKEN, DISCORD_CLIENT_SECRET]
}, async (req, res) => {
  setCors(res, req);
  if (req.method === "OPTIONS") return res.status(204).send("");

  const uid = await verifyUser(req, res);
  if (!uid) return;

  const code = req.body && req.body.code;
  const redirectUri = req.body && req.body.redirectUri;

  if (!code || !redirectUri) {
    return res.status(400).json({ success: false, message: "Discord authorization code와 redirectUri가 필요합니다." });
  }

  try {
    let botToken = "";
    let clientSecret = "";

    try {
      botToken = DISCORD_BOT_TOKEN.value();
    } catch (e) {
      botToken = process.env.DISCORD_BOT_TOKEN || "";
    }

    try {
      clientSecret = DISCORD_CLIENT_SECRET.value();
    } catch (e) {
      clientSecret = process.env.DISCORD_CLIENT_SECRET || "";
    }

    if (!botToken || !clientSecret) {
      return res.status(500).json({ 
        success: false, 
        message: "서버에 디스코드 봇 토큰 또는 시크릿 설정이 누락되어 있습니다." 
      });
    }

    // 1. OAuth code로 Discord 유저 정보 획득
    const discordUser = await getDiscordUserWithCode(code, redirectUri, DISCORD_CLIENT_ID, clientSecret);

    // 2. 디스코드 봇 API로 크리에이터 서버 멤버 역할 목록 조회
    const roleCheck = await checkGuildMemberRole(botToken, DISCORD_GUILD_ID, discordUser.id, DISCORD_ROLE_ID);
    const userRoles = roleCheck.roles || [];

    // 3. Auth Custom Claims 단독 계정 권한(role) 조회 (owner / admin 여부)
    const userAccountRole = await getUserRoleFromAuth(uid);

    // 4. 우선순위에 따른 등급 이름 (levelName) 및 활성화(isMemberActive) 결정
    let levelName = null;
    let isMemberActive = false;

    // 디스코드 역할 ID 매핑 (우선순위 순으로 정렬)
    const ROLE_MAP = [
      { id: "1462257396020809804", name: "이사님" },
      { id: "1462257396020809803", name: "간부" },
      { id: "1462257396020809802", name: "분대장" },
      { id: "1462257396020809801", name: "대원" },
      { id: "1462257396020809800", name: "유튜브 멤버십" },
      { id: "914789528487735317",  name: "디스코드 서버 부스터" }
    ];

    // 우선순위 1: 소유자
    if (userAccountRole === "owner") {
      levelName = "소유자";
      isMemberActive = true;
    }
    // 우선순위 2: 관리자
    else if (userAccountRole === "admin") {
      levelName = "관리자";
      isMemberActive = true;
    }
    // 우선순위 3~5: 디스코드 역할군
    else {
      for (const item of ROLE_MAP) {
        if (userRoles.includes(item.id)) {
          levelName = item.name;
          isMemberActive = true;
          break; // 가장 높은 우선순위 하나만 선택
        }
      }
    }

    if (!isMemberActive) {
      levelName = "일반";
    }

    const membership = {
      status: isMemberActive ? "active" : "none",
      type: "discord",
      levelName: levelName,
      discordId: discordUser.id,
      discordUsername: discordUser.username,
      lastChecked: Date.now()
    };

    // 5. Firestore 사용자 설정에 저장
    await db.collection("users").doc(uid).set({
      settings: {
        membership
      }
    }, { merge: true });

    return res.json({
      success: true,
      membership,
      isMemberActive,
      discordUser,
      details: isMemberActive ? `멤버십 인증 완료 (${levelName})` : "디스코드 서버에 가입되어 있지 않거나 인증 가능한 역할이 없음"
    });

  } catch (err) {
    console.error("checkMembershipDiscord error:", err);
    return res.status(500).json({
      success: false,
      message: `디스코드 멤버십 연동 실패: ${err.message || '알 수 없는 오류'}`
    });
  }
});

// [보조] 유튜브 채널 ID 기반 CSV 회원 목록 비교 멤버십 검증
exports.checkMembershipCsv = onRequest({
  invoker: "public"
}, async (req, res) => {
  setCors(res, req);
  if (req.method === "OPTIONS") return res.status(204).send("");

  const uid = await verifyUser(req, res);
  if (!uid) return;

  const userChannelId = (req.body && req.body.userChannelId) || req.query.userChannelId;
  if (!userChannelId) {
    return res.status(400).json({ success: false, message: "userChannelId가 누락되었습니다." });
  }

  try {
    // 1. Auth Custom Claims 단독 계정 권한(role) 조회 (owner / admin 여부)
    const userRole = await getUserRoleFromAuth(uid);

    // 2. Firestore membership_csv_users 문서 확인
    const csvDocRef = db.collection("membership_csv_users").doc(userChannelId);
    const docSnap = await csvDocRef.get();

    const isCsvMember = docSnap.exists;
    const memberData = docSnap.data() || {};

    let isMemberActive = isCsvMember;
    let finalLevelName = "일반";

    // 우선순위 판별 (1순위: 소유자 > 2순위: 관리자 > 3순위: CSV 등록 멤버십 등급)
    if (userRole === "owner") {
      isMemberActive = true;
      finalLevelName = "소유자";
    } else if (userRole === "admin") {
      isMemberActive = true;
      finalLevelName = "관리자";
    } else if (isCsvMember) {
      finalLevelName = memberData.levelName || "유튜브 멤버십";
    }

    const membership = {
      status: isMemberActive ? "active" : "none",
      type: "csv",
      levelName: finalLevelName,
      userChannelId: userChannelId,
      lastChecked: Date.now()
    };

    // 3. Firestore 사용자 설정에 저장
    await db.collection("users").doc(uid).set({
      settings: {
        membership
      }
    }, { merge: true });

    return res.json({
      success: true,
      membership,
      isMemberActive
    });

  } catch (err) {
    console.error("checkMembershipCsv error:", err);
    return res.status(500).json({
      success: false,
      message: `CSV 멤버십 검증 실패: ${err.message || '알 수 없는 오류'}`
    });
  }
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

  const uid = await verifyUser(req, res);
  if (!uid) return;

  // 관리자 권한 확인 (Auth Custom Claims 단독 검사)
  const userRole = await getUserRoleFromAuth(uid);
  const isAdmin = userRole === "admin" || userRole === "owner";

  if (!isAdmin) {
    return res.status(403).json({ success: false, message: "관리자 권한이 필요합니다." });
  }

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
    console.error("uploadMembershipCsv error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});
