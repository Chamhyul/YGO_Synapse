#!/usr/bin/env node

/**
 * [YGO Synapse] 유튜브 멤버십 CSV 로컬 일괄 업로드 CLI 스크립트
 * 
 * 사용법:
 *   node scripts/upload_membership_csv.js "/경로/Members_2026-08-25.csv"
 */

const fs = require('fs');
const path = require('path');
const { initializeDataToolFirebaseApp } = require('./cloud_credentials');

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

// 3. 로컬 계정·단기 인증만 사용한다. 저장소의 서비스 계정 키는 탐색하지 않는다.
try {
    initializeDataToolFirebaseApp(admin, { projectId: 'ygo-synapse' });
} catch (initErr) {
    console.error("❌ Firebase Admin 초기화 실패:", initErr.message);
    console.error("   로컬 계정의 기본 인증 설정을 확인해 주세요. 서비스 계정 키는 지원하지 않습니다.");
    process.exit(1);
}

const db = admin.firestore();

const { randomBytes } = require('node:crypto');
const { createMembershipCsvService, createFirestoreMembershipCsvStore, membershipCsvParseMembers } = require('../functions/services/membershipCsvService');

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
    const csvContent = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(csvFilePath));
    const members = membershipCsvParseMembers(csvContent);

    if (members.length === 0) {
        console.error("❌ 파싱 가능한 멤버십 회원 데이터가 없습니다.");
        process.exit(1);
    }

    console.log(`🔍 총 ${members.length}명의 회원 데이터 파싱 완료.`);
    console.log("⏳ Firestore 데이터베이스 갱신 중 (기존 데이터 교체)...");

    const service = createMembershipCsvService({ store: createFirestoreMembershipCsvStore(db) });
    const preview = await service.preview({ members });
    await service.apply({ members, ...preview, operationId: randomBytes(16).toString('hex') }, 'adc-cli');

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
    console.error("❌ Firestore 갱신 결과를 확인하지 못했습니다. 원본 CSV는 유지됩니다.");
    process.exit(1);
});
