#!/usr/bin/env node

/**
 * [YGO Synapse] 유튜브 멤버십 CSV 로컬 일괄 업로드 CLI 스크립트
 * 
 * 사용법:
 *   node scripts/upload_membership_csv.js "/경로/Members_2026-08-25.csv"
 */

const fs = require('fs');
const path = require('path');

// 1. firebase-admin 모듈 로드 (functions/node_modules 또는 전역/로컬 탐색)
let admin;
try {
    admin = require('../functions/node_modules/firebase-admin');
} catch (e) {
    try {
        admin = require('firebase-admin');
    } catch (err) {
        console.error("❌ firebase-admin 모듈을 찾을 수 없습니다. (functions 폴더에서 npm install이 필요합니다)");
        process.exit(1);
    }
}

// 2. 인자(CSV 파일 경로) 검증
const csvFilePath = process.argv[2];
if (!csvFilePath) {
    console.error("❌ CSV 파일 경로를 인자로 전달해야 합니다.");
    console.error("   사용법: node upload_membership_csv.js <CSV파일경로>");
    process.exit(1);
}

if (!fs.existsSync(csvFilePath)) {
    console.error(`❌ 지정한 CSV 파일을 찾을 수 없습니다: ${csvFilePath}`);
    process.exit(1);
}

// 3. Firebase Admin SDK 초기화 (서비스 계정 키 파일 우선 적용)
const possibleKeyPaths = [
    path.join(__dirname, '../functions/serviceAccountKey.json'),
    path.join(__dirname, './serviceAccountKey.json'),
    path.join(__dirname, '../serviceAccountKey.json')
];

let serviceAccountPath = possibleKeyPaths.find(p => fs.existsSync(p));

try {
    if (!admin.apps.length) {
        if (serviceAccountPath) {
            const serviceAccount = require(serviceAccountPath);
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount),
                projectId: serviceAccount.project_id || 'ygo-synapse'
            });
        } else {
            // 키 파일이 없을 경우 기본 Google Application Default Credentials 사용
            admin.initializeApp({
                projectId: 'ygo-synapse'
            });
        }
    }
} catch (initErr) {
    console.error("❌ Firebase Admin 초기화 실패:", initErr.message);
    console.error("   functions/serviceAccountKey.json 키 파일이 올바르게 배치되었는지 확인해 주세요.");
    process.exit(1);
}

const db = admin.firestore();

// 4. CSV 텍스트 파싱 헬퍼 함수
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

// 5. 파일명 표준 포맷 변환 함수 (YYYY.M.D H_M.csv)
function formatCsvFileName(originalName) {
    // 연도(20XX), 월(1~12), 일(1~31), [선택] 시(0~23), 분(0~59) 추출 정규식
    const match = originalName.match(/(20\d{2})[-._\s]+(1[0-2]|0?[1-9])[-._\s]+(3[01]|[12]\d|0?[1-9])(?:[-._\s]+(2[0-3]|1\d|0?\d)[-._:]+([1-5]\d|0?\d))?/);
    
    const now = new Date();
    let year = now.getFullYear();
    let month = now.getMonth() + 1;
    let day = now.getDate();
    let hour = now.getHours();
    let minute = now.getMinutes();

    if (match) {
        year = parseInt(match[1], 10);
        month = parseInt(match[2], 10);
        day = parseInt(match[3], 10);
        
        // 시, 분이 원본 파일명에 포함되어 있는 경우에만 덮어씀
        if (match[4] !== undefined && match[5] !== undefined) {
            hour = parseInt(match[4], 10);
            minute = parseInt(match[5], 10);
        }
    }

    return `${year}.${month}.${day} ${hour}_${minute}.csv`;
}

// 6. 대상 구글 드라이브 보관 폴더 경로
const TARGET_DEST_DIR = "/Users/ch97/Library/CloudStorage/GoogleDrive-yshun0219@gmail.com/내 드라이브/Google Drive/Youtube/0. Games/Yu-Gi-Oh! Master Duel/05. source/00. membership/00. CSV list";

// 7. 메인 실행 함수
async function main() {
    console.log(`⏳ CSV 파일 읽는 중: ${csvFilePath}`);
    const csvContent = fs.readFileSync(csvFilePath, 'utf8');
    const members = parseYoutubeMembersCsv(csvContent);

    if (members.length === 0) {
        console.error("❌ 파싱 가능한 멤버십 회원 데이터가 없습니다.");
        process.exit(1);
    }

    console.log(`🔍 총 ${members.length}명의 회원 데이터 파싱 완료.`);
    console.log("⏳ Firestore 데이터베이스 갱신 중 (기존 데이터 교체)...");

    const collectionRef = db.collection("membership_csv_users");

    // 7-1. 기존 데이터 전수 삭제 (500개 단위 배치 처리)
    const existingSnap = await collectionRef.get();
    if (!existingSnap.empty) {
        const docs = existingSnap.docs;
        for (let i = 0; i < docs.length; i += 450) {
            const deleteBatch = db.batch();
            const chunk = docs.slice(i, i + 450);
            chunk.forEach(doc => deleteBatch.delete(doc.ref));
            await deleteBatch.commit();
        }
    }

    // 7-2. 신규 데이터 일괄 등록 (500개 단위 배치 처리)
    const now = Date.now();
    for (let i = 0; i < members.length; i += 450) {
        const insertBatch = db.batch();
        const chunk = members.slice(i, i + 450);
        chunk.forEach(item => {
            if (item.channelId) {
                const docRef = collectionRef.doc(item.channelId);
                insertBatch.set(docRef, {
                    channelId: item.channelId,
                    memberName: item.memberName || "",
                    levelName: item.levelName || "유튜브 멤버십",
                    updatedAt: now
                });
            }
        });
        await insertBatch.commit();
    }

    let moveInfo = "";

    // 7-3. Firestore 갱신 성공 후, 구글 드라이브 보관 폴더로 파일명 변환 및 이동
    try {
        const originalFileName = path.basename(csvFilePath);
        const formattedFileName = formatCsvFileName(originalFileName);

        if (!fs.existsSync(TARGET_DEST_DIR)) {
            fs.mkdirSync(TARGET_DEST_DIR, { recursive: true });
        }

        const destPath = path.join(TARGET_DEST_DIR, formattedFileName);
        fs.copyFileSync(csvFilePath, destPath);
        fs.unlinkSync(csvFilePath); // 다운로드 폴더의 원본 파일 정리
        moveInfo = `\n📁 보관 완료: ${formattedFileName}`;
        console.log(`✅ 구글 드라이브 이동 완료: ${destPath}`);
    } catch (moveErr) {
        console.warn(`⚠️ 파일 이동 중 오류 발생 (DB는 갱신 완료됨): ${moveErr.message}`);
        moveInfo = `\n(⚠️ 파일 이동 실패: ${moveErr.message})`;
    }

    console.log(`총 ${members.length}명의 멤버십 회원 갱신 완료!${moveInfo}`);
    process.exit(0);
}

main().catch(err => {
    console.error("❌ Firestore 갱신 실패:", err);
    process.exit(1);
});

