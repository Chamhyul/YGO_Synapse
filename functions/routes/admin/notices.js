/**
 * [공지사항 및 시스템 관리자 권한 API]
 * 
 * 1. manageNotice : 공지사항 추가·수정·삭제 (owner, admin 권한 필요)
 * 2. manageAdminRole : 관리자 지정/박탈/조회 (owner 전용)
 */

const { onRequest } = require("firebase-functions/v2/https");
const { db, admin } = require("../../config/firebase");
const { setCors, verifyUser } = require("../../utils/auth");
const cheerio = require("cheerio");

const STORAGE_PATH = "public/notices.json";
const ALLOWED_NOTICE_TAGS = new Set([
  "a", "b", "blockquote", "br", "code", "del", "div", "em", "h1", "h2", "h3",
  "h4", "h5", "h6", "hr", "i", "li", "ol", "p", "pre", "s", "span", "strong", "u", "ul",
]);
const DROP_WITH_CONTENT_TAGS = new Set([
  "base", "embed", "frame", "iframe", "link", "meta", "object", "script", "style", "svg", "template",
]);

function isSafeNoticeHref(href) {
  try {
    const url = new URL(href, "https://ygo-synapse.web.app");
    return ["http:", "https:", "mailto:"].includes(url.protocol);
  } catch {
    return false;
  }
}

/** 허용된 서식만 남기고 공지 HTML에서 실행 가능한 요소와 속성을 제거합니다. */
function sanitizeNoticeHtml(content) {
  const $ = cheerio.load(String(content || ""), null, false);

  $("*").toArray().reverse().forEach(node => {
    const tag = node.tagName && node.tagName.toLowerCase();
    if (!tag) return;

    if (!ALLOWED_NOTICE_TAGS.has(tag)) {
      if (DROP_WITH_CONTENT_TAGS.has(tag)) $(node).remove();
      else $(node).replaceWith($(node).contents());
      return;
    }

    const attrs = node.attribs || {};
    const href = attrs.href;
    const title = attrs.title;
    const target = attrs.target;
    Object.keys(attrs).forEach(name => $(node).removeAttr(name));

    if (tag === "a") {
      if (href && isSafeNoticeHref(href)) $(node).attr("href", href);
      if (title) $(node).attr("title", title);
      if (target === "_blank") {
        $(node).attr("target", "_blank");
        $(node).attr("rel", "noopener noreferrer");
      }
    }
  });

  return $.root().html() || "";
}

function sanitizeNoticeTitle(title) {
  const $ = cheerio.load(String(title || ""), null, false);
  return $.text().trim();
}

/** 현재 KST 시각을 "YYYY-MM-DDTHH:MM" 형식으로 반환 */
function getKstDatetimeId() {
  const now = new Date();
  // KST = UTC+9
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const yyyy = kst.getUTCFullYear();
  const mm = String(kst.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(kst.getUTCDate()).padStart(2, "0");
  const hh = String(kst.getUTCHours()).padStart(2, "0");
  const mi = String(kst.getUTCMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}

/** Storage에서 현재 notices.json을 읽어 notices 배열을 반환 */
async function readNotices() {
  try {
    const bucket = admin.storage().bucket();
    const file = bucket.file(STORAGE_PATH);
    const [exists] = await file.exists();
    if (!exists) return [];
    const [content] = await file.download();
    const data = JSON.parse(content.toString("utf-8"));
    return Array.isArray(data.notices) ? data.notices : [];
  } catch (e) {
    console.warn("[NoticesAdmin] readNotices failed or file missing:", e.message || e);
    return [];
  }
}

/** notices 배열을 정렬 후 Storage에 저장 */
async function saveNotices(notices) {
  const sorted = [...notices].sort((a, b) => {
    const aPinned = a.isPinned > 0;
    const bPinned = b.isPinned > 0;
    if (aPinned && bPinned) return a.isPinned - b.isPinned;
    if (aPinned && !bPinned) return -1;
    if (!aPinned && bPinned) return 1;
    return b.id.localeCompare(a.id);
  });

  const payload = {
    updatedAt: Date.now(),
    notices: sorted,
  };

  const bucket = admin.storage().bucket();
  const file = bucket.file(STORAGE_PATH);
  await file.save(JSON.stringify(payload, null, 2), {
    contentType: "application/json",
    public: true,
    metadata: { cacheControl: "public, max-age=3600" },
  });

  return sorted;
}

/** 유저의 role 및 admin 권한 정보 조회 (Custom Claims 기반) */
async function getUserRoleInfo(uid) {
  try {
    const user = await admin.auth().getUser(uid);
    const claims = user.customClaims || {};
    const isAdmin = claims.admin === true || claims.role === "owner" || claims.role === "admin";
    const role = claims.role || (claims.admin ? "admin" : "none");
    return {
      uid,
      email: user.email || "",
      displayName: user.displayName || "",
      isAdmin,
      role
    };
  } catch (e) {
    return {
      uid,
      email: "",
      displayName: "",
      isAdmin: false,
      role: "none"
    };
  }
}

// ─── 1. 공지사항 관리 API (manageNotice) ──────────────────────────
exports.manageNotice = onRequest(
  { invoker: "public", timeoutSeconds: 30, memory: "256MiB" },
  async (req, res) => {
    setCors(res, req);
    if (req.method === "OPTIONS") return res.status(204).send("");

    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method Not Allowed. Use POST." });
    }

    const uid = await verifyUser(req, res);
    if (!uid) return;

    const caller = await getUserRoleInfo(uid);
    if (!caller.isAdmin) {
      return res.status(403).json({ success: false, error: "Forbidden: 관리자 권한이 필요합니다." });
    }

    const { action, id, title, content, isPinned } = req.body || {};

    try {
      let notices = await readNotices();

      if (action === "add") {
        if (!title) return res.status(400).json({ error: "title 필드가 필요합니다." });
        const newId = getKstDatetimeId();
        const finalId = notices.some(n => n.id === newId)
          ? (() => {
              const [datePart, timePart] = newId.split("T");
              const [hh, mi] = timePart.split(":").map(Number);
              const nextMi = String((mi + 1) % 60).padStart(2, "0");
              const nextHh = mi === 59 ? String((hh + 1) % 24).padStart(2, "0") : String(hh).padStart(2, "0");
              return `${datePart}T${nextHh}:${nextMi}`;
            })()
          : newId;

        const newNotice = {
          id: finalId,
          date: finalId.substring(0, 10),
          title: sanitizeNoticeTitle(title),
          content: sanitizeNoticeHtml(content),
          isPinned: parseInt(isPinned) || 0,
        };

        notices.push(newNotice);
        const sorted = await saveNotices(notices);
        return res.json({ success: true, action: "add", notice: newNotice, notices: sorted });
      }

      if (action === "update") {
        if (!id) return res.status(400).json({ error: "id 필드가 필요합니다." });
        const idx = notices.findIndex(n => n.id === id);
        if (idx === -1) return res.status(404).json({ error: `id '${id}'에 해당하는 공지가 없습니다.` });

        if (title !== undefined) notices[idx].title = sanitizeNoticeTitle(title);
        if (content !== undefined) notices[idx].content = sanitizeNoticeHtml(content);
        if (isPinned !== undefined) notices[idx].isPinned = parseInt(isPinned) || 0;

        const sorted = await saveNotices(notices);
        return res.json({ success: true, action: "update", notice: notices[idx], notices: sorted });
      }

      if (action === "delete") {
        if (!id) return res.status(400).json({ error: "id 필드가 필요합니다." });
        const before = notices.length;
        notices = notices.filter(n => n.id !== id);
        if (notices.length === before) return res.status(404).json({ error: `id '${id}'에 해당하는 공지가 없습니다.` });

        const sorted = await saveNotices(notices);
        return res.json({ success: true, action: "delete", deletedId: id, notices: sorted });
      }

      return res.status(400).json({ error: "알 수 없는 action입니다. add | update | delete" });
    } catch (e) {
      console.error("[NoticesAdmin] manageNotice failed:", e);
      return res.status(500).json({ success: false, message: e.toString() });
    }
  }
);

// ─── 2. 시스템 관리자 권한 및 DB 연동 API (manageAdminRole) ─────
exports.manageAdminRole = onRequest(
  { invoker: "public", timeoutSeconds: 30, memory: "256MiB" },
  async (req, res) => {
    setCors(res, req);
    if (req.method === "OPTIONS") return res.status(204).send("");

    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method Not Allowed. Use POST." });
    }

    const uid = await verifyUser(req, res);
    if (!uid) return;

    const caller = await getUserRoleInfo(uid);
    if (!caller.isAdmin) {
      return res.status(403).json({ success: false, error: "Forbidden: 관리자 권한이 필요합니다." });
    }

    const { action, targetUid, isAdmin } = req.body || {};

    try {
      // ── action: list (관리자 목록 조회) ───────────────────
      if (action === "list") {
        const adminList = [];
        
        // Auth 사용자 목록 스캔 (Custom Claims 확인)
        let nextPageToken;
        do {
          const listResult = await admin.auth().listUsers(1000, nextPageToken);
          listResult.users.forEach(u => {
            const claims = u.customClaims || {};
            if (claims.admin || claims.role === "owner" || claims.role === "admin") {
              adminList.push({
                uid: u.uid,
                email: u.email || "",
                displayName: u.displayName || "",
                role: claims.role || "admin",
                isAdmin: true
              });
            }
          });
          nextPageToken = listResult.pageToken;
        } while (nextPageToken);

        return res.json({ success: true, count: adminList.length, adminList });
      }

      // ── action: setAdmin 또는 setOwner (권한 지정 및 DB 멤버십 연동) ───
      if (action === "setAdmin" || action === "setOwner") {
        // 관리자 지정/박탈은 오직 owner (총책임자) 권한 보유자만 실행 가능 (권한 싸움 방지)
        if (caller.role !== "owner") {
          return res.status(403).json({ 
            success: false, 
            error: "Forbidden: 관리자 권한 부여 및 박탈은 총책임자(owner) 권한만 가능합니다." 
          });
        }

        if (!targetUid) {
          return res.status(400).json({ error: "targetUid 필드가 필요합니다." });
        }

        const targetIsOwner = action === "setOwner";
        const targetIsAdmin = targetIsOwner ? true : Boolean(isAdmin);
        const newRole = targetIsOwner ? "owner" : (targetIsAdmin ? "admin" : "none");

        // 1. Firebase Auth Custom Claims 부여/해제
        await admin.auth().setCustomUserClaims(targetUid, {
          role: newRole,
          admin: targetIsAdmin
        });

        // 2. Firestore DB users/{targetUid} 멤버십 상태 자동 반영 및 원복
        const userRef = db.collection("users").doc(targetUid);
        if (targetIsAdmin) {
          // 관리자 등록 시: Administrator 멤버십 혜택 자동 부여
          await userRef.set({
            settings: {
              membership: {
                status: "active",
                levelName: "Administrator",
                lastChecked: Date.now()
              }
            }
          }, { merge: true });
        } else {
          // 관리자 해제 시: 기존 레벨명이 Administrator인 경우 일반유저(none)로 자동 원복
          const snap = await userRef.get();
          if (snap.exists) {
            const data = snap.data() || {};
            const mem = (data.settings && data.settings.membership) || {};
            if (mem.levelName === "Administrator") {
              await userRef.set({
                settings: {
                  membership: {
                    status: "none",
                    lastChecked: Date.now()
                  }
                }
              }, { merge: true });
            }
          }
        }

        console.log(`[ManageAdminRole] ${action}: targetUid=${targetUid}, role=${newRole}`);
        return res.json({
          success: true,
          action,
          targetUid,
          role: newRole,
          isAdmin: targetIsAdmin,
          message: targetIsAdmin 
            ? `UID ${targetUid}에 ${newRole} 권한 및 DB Administrator 멤버십이 적용되었습니다.`
            : `UID ${targetUid}의 관리자 권한이 해제되고 DB 멤버십이 일반으로 원복되었습니다.`
        });
      }

      return res.status(400).json({ error: "알 수 없는 action입니다. list | setAdmin | setOwner" });

    } catch (e) {
      console.error("[ManageAdminRole] failed:", e);
      return res.status(500).json({ success: false, message: e.toString() });
    }
  }
);
