/**
 * [공지사항 및 시스템 관리자 권한 API]
 * 
 * 1. manageNotice : 공지사항 추가·수정·삭제 (owner, admin 권한 필요)
 * 2. manageAdminRole : 관리자 지정/박탈/조회 (owner 전용)
 */

const { onRequest } = require("firebase-functions/v2/https");
const { db, admin } = require("../../config/firebase");
const { setCors, verifyUser } = require("../../utils/auth");
const { createNoticeService, createStorageNoticeStore } = require('../../services/noticeService');
const { getProductionCredential } = require('../../config/firebase');
const { withLocalNoticeLock } = require('../../services/localNoticeLock');
let noticeService;
function notices() {
  const local = process.env.FUNCTIONS_EMULATOR === 'true';
  if (local && (!process.env.FIREBASE_STORAGE_EMULATOR_HOST || !process.env.FIRESTORE_EMULATOR_HOST)) throw Error('로컬 Storage가 필요합니다.');
  return noticeService ||= createNoticeService({storage:createStorageNoticeStore(admin.storage().bucket()),environment:local?'local':'production',runLocked:local?action=>withLocalNoticeLock(db,action):undefined});
}
function noticeAuth() {
  if (process.env.FIREBASE_AUTH_EMULATOR_HOST) throw Error('실제 Firebase Auth가 필요합니다.');
  if (process.env.FUNCTIONS_EMULATOR !== 'true') return admin.auth();
  const name='admin-web-auth';
  const app=admin.apps.find(a=>a.name===name)||admin.initializeApp({credential:getProductionCredential(),projectId:'ygo-synapse'},name);
  return admin.auth(app);
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
  { invoker: 'public', timeoutSeconds: 30, memory: '256MiB' },
  async (req,res) => {
    setCors(res,req);
    if(req.method==='OPTIONS')return res.status(204).send('');
    if(req.method!=='POST')return res.status(405).json({success:false});
    try {
      const header=req.headers.authorization;
      if(typeof header!=='string'||!header.startsWith('Bearer '))return res.status(401).json({success:false});
      let decoded;
      try {decoded=await noticeAuth().verifyIdToken(header.slice(7),true);}catch{return res.status(401).json({success:false});}
      const user=await noticeAuth().getUser(decoded.uid),claims=user.customClaims||{};
      if(user.disabled)return res.status(401).json({success:false});
      if(claims.admin!==true && !['owner','admin'].includes(claims.role))return res.status(403).json({success:false});
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
