/**
 * [공지사항 및 시스템 관리자 권한 API]
 * 
 * 1. manageNotice : 공지사항 추가·수정·삭제 (owner, admin 권한 필요)
 * 2. manageAdminRole : 관리자 지정/박탈/조회 (owner 전용)
 */

const { onRequest } = require("firebase-functions/v2/https");
const { db, admin } = require("../../config/firebase");
const { setCors, verifyAdmin } = require("../../utils/auth");
const { createNoticeService, createStorageNoticeStore } = require('../../services/noticeService');
const { forwardAdminRequest } = require('../../services/adminActionTransport');
const { safeErrorSummary } = require('../../utils/safeError');
let noticeService;
function notices() {
  return noticeService ||= createNoticeService({storage:createStorageNoticeStore(admin.storage().bucket()),environment:'production'});
}

// ─── 1. 공지사항 관리 API (manageNotice) ──────────────────────────
exports.manageNotice = onRequest(
  { invoker: 'public', timeoutSeconds: 30, memory: '256MiB' },
  async (req,res) => {
    setCors(res,req);
    if(req.method==='OPTIONS')return res.status(204).send('');
    if(await forwardAdminRequest(req,res,'manageNotice'))return;
    if(req.method!=='POST')return res.status(405).json({success:false});
    try {
      if(!(await verifyAdmin(req,res)))return;
      return res.json({success:true,...await notices().mutate(req.body,{requireRevision:false})});
    }catch(error){
      if([400,404,409].includes(error.status))return res.status(error.status).json({success:false,message:error.message});
      return res.status(503).json({success:false,message:'공지 작업을 완료할 수 없습니다.'});
    }
  }
);

// ─── 2. 시스템 관리자 권한 및 DB 연동 API (manageAdminRole) ─────
exports.manageAdminRole = onRequest(
  { invoker: "public", timeoutSeconds: 30, memory: "256MiB" },
  async (req, res) => {
    setCors(res, req);
    if (req.method === "OPTIONS") return res.status(204).send("");
    if (await forwardAdminRequest(req, res, 'manageAdminRole')) return;

    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method Not Allowed. Use POST." });
    }

    const { action, targetUid, isAdmin } = req.body || {};
    const caller = await verifyAdmin(req, res, { ownerOnly: action === 'setAdmin' || action === 'setOwner' });
    if (!caller) return;

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

      // ── action: setAdmin 또는 setOwner (현재 계정 권한 지정) ───
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

        // 회원 혜택은 현재 Auth 권한에서 계산하며 외부 회원 기록은 덮어쓰지 않는다.

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
      console.error("[ManageAdminRole] failed:", safeErrorSummary(e));
      return res.status(500).json({ success: false, message: "관리자 권한 변경에 실패했습니다." });
    }
  }
);
