const { onSchedule } = require("firebase-functions/v2/scheduler");
const { runAutoCrawl } = require("../services/autoCrawlerService");
const { ALL_LOCALES, MAIN_LOCALES } = require("../config/crawler");

exports.autoCrawlFull = onSchedule({
  schedule: "0 4 * * *",
  timeZone: "Asia/Seoul",
  region: "asia-northeast3",
  memory: "1GiB",
  timeoutSeconds: 540,
}, async (event) => {
  console.log("[Scheduler] 전체 언어 자동 크롤링 시작 (04:00 KST)");
  const result = await runAutoCrawl(ALL_LOCALES);
  console.log("[Scheduler] 전체 언어 크롤링 결과:", JSON.stringify(result));
});

/**
 * 매일 12:00, 22:00 KST - 주요 3개 언어만 스캔
 */
exports.autoCrawlQuick = onSchedule({
  schedule: "0 12,22 * * *",
  timeZone: "Asia/Seoul",
  region: "asia-northeast3",
  memory: "1GiB",
  timeoutSeconds: 540,
}, async (event) => {
  console.log("[Scheduler] 주요 언어 자동 크롤링 시작 (12:00/22:00 KST)");
  const result = await runAutoCrawl(MAIN_LOCALES);
  console.log("[Scheduler] 주요 언어 크롤링 결과:", JSON.stringify(result));
});

