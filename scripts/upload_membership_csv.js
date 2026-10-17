#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { randomBytes } = require('node:crypto');
const { createMembershipCsvService, membershipCsvParseMembers } = require('../functions/services/membershipCsvService');

function parseArgs(args) {
    const flags = new Set(args.filter(value => value.startsWith('--')));
    if ([...flags].some(value => !['--rtdb-emulator', '--writer-emulator', '--writer-production', '--dry-run'].includes(value)) || flags.size !== args.filter(value => value.startsWith('--')).length) {
        throw Error('지원하지 않는 실행 옵션입니다. 운영 RTDB 업로드는 아직 열려 있지 않습니다.');
    }
    if (['--rtdb-emulator', '--writer-emulator', '--writer-production'].filter(flag => flags.has(flag)).length > 1) throw Error('실행 대상을 하나만 지정해 주세요.');
    const files = args.filter(value => !value.startsWith('--'));
    if (files.length !== 1) throw Error('CSV 파일 경로를 하나 지정해 주세요.');
    return { csvFilePath: files[0], emulator: flags.has('--rtdb-emulator'), ...(flags.has('--writer-emulator') ? { writerEmulator: true } : {}),
        ...(flags.has('--writer-production') ? { writerProduction: true } : {}), dryRun: flags.has('--dry-run') };
}
function validateTarget(options, env = process.env) {
  if (options.writerProduction) {
    const config = require('../functions/config/userProfileWriter').resolveProfileWriterConfig(env);
    if (config.mode !== 'production') throw Error('등록된 운영 공통 writer가 필요합니다.'); return config;
  }
  if (options.writerEmulator) return require('../functions/config/userProfileWriter').resolveProfileWriterConfig(env);
  if (env.USER_PROFILE_WRITER_MODE) throw new Error('이 관리 도구는 공통 writer 전환에 아직 연결되지 않았습니다.');
    if (options.emulator) return require('../functions/config/userStorage').resolveRtdbConfig(env);
    if (![undefined, '', 'storage'].includes(env.USER_STORAGE_BACKEND) || env.USER_STORAGE_MODE) {
        throw Error('RTDB 시험 업로드는 --rtdb-emulator를 명시해야 합니다. 운영 RTDB 업로드는 아직 열려 있지 않습니다.');
    }
    return { mode: 'legacy' };
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


const TARGET_DEST_DIR = "/Users/ch97/Library/CloudStorage/GoogleDrive-yshun0219@gmail.com/내 드라이브/Google Drive/Youtube/0. Games/Yu-Gi-Oh! Master Duel/05. source/00. membership/00. CSV list";


async function main(args = process.argv.slice(2)) {
    const options = parseArgs(args);
    // 실행 대상은 실제 프로세스 설정으로 검증한다. 순수 검사용 env를 런타임 선택과 섞지 않는다.
    validateTarget(options, process.env);
    const { csvFilePath } = options;
    const csvContent = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(csvFilePath));
    const members = membershipCsvParseMembers(csvContent);
    if (options.dryRun) {
        console.log(`검사 완료: ${members.length}명. DB와 원본 파일은 변경하지 않았습니다.`);
        return;
    }
    let close;
    try {
        let db, writerBinding;
        if (options.writerEmulator || options.writerProduction) {
            const runtime = require('../functions/services/userProfileWriterRuntime');
            close = runtime.closeProfileWriterRuntime; writerBinding = runtime.getProfileWriterBinding();
        } else if (options.emulator) {
            close = require('../functions/services/userStorageRuntime').closeRtdbUserStorage;
        } else {
            let admin;
            try { admin = require('../functions/node_modules/firebase-admin'); }
            catch { admin = require('firebase-admin'); }
            require('./cloud_credentials').initializeDataToolFirebaseApp(admin, { projectId: 'ygo-synapse' });
            db = admin.firestore();
        }
        const { getMembershipCsvStore } = require('../functions/services/membershipCsvRepository');
        const service = createMembershipCsvService({ store: getMembershipCsvStore({ db, writerBinding }) });
        const preview = await service.preview({ members });
        await service.apply({ members, ...preview, operationId: randomBytes(16).toString('hex') }, 'adc-cli');
        // 격리 RTDB 시험은 실제 파일 보관 폴더와 원본 파일을 변경하지 않는다.
        if (!options.emulator && !options.writerEmulator && !options.writerProduction) {
            try {
                const formattedFileName = formatCsvFileName(path.basename(csvFilePath));
                if (!fs.existsSync(TARGET_DEST_DIR)) fs.mkdirSync(TARGET_DEST_DIR, { recursive: true });
                fs.copyFileSync(csvFilePath, path.join(TARGET_DEST_DIR, formattedFileName));
                fs.unlinkSync(csvFilePath);
                console.log(`보관 완료: ${formattedFileName}`);
            } catch (_) { console.warn('DB 적용은 완료됐으나 파일 보관은 완료하지 못했습니다. 원본 CSV를 확인해 주세요.'); }
        }
        console.log(`총 ${members.length}명의 멤버십 회원 갱신 완료`);
    } finally { if (close) await close(); }
}

module.exports = { parseArgs, validateTarget, formatCsvFileName, main };
// 독립 CLI의 기존 종료 동작을 유지한다. import해서 main을 호출하면 프로세스를 종료하지 않는다.
if (require.main === module) main().then(() => process.exit(0), () => {
    console.error('목록 적용 결과를 확인하지 못했습니다. 원본 CSV는 유지됩니다.');
    process.exit(1);
});
