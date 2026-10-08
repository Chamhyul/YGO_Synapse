const admin = require("firebase-admin");
const { FieldValue, FieldPath } = require("firebase-admin/firestore");
const { defineSecret } = require("firebase-functions/params");

if (!admin.apps.length) {
  admin.initializeApp({
    storageBucket: process.env.STORAGE_BUCKET || "ygo-synapse.firebasestorage.app"
  });
}
const db = admin.firestore();

// Secrets 정의
const GOOGLE_CLIENT_ID = defineSecret("GOOGLE_CLIENT_ID");
const GOOGLE_CLIENT_SECRET = defineSecret("GOOGLE_CLIENT_SECRET");
const GOOGLE_REFRESH_TOKEN = defineSecret("GOOGLE_REFRESH_TOKEN");
const DISCORD_BOT_TOKEN = defineSecret("DISCORD_BOT_TOKEN");
const DISCORD_CLIENT_SECRET = defineSecret("DISCORD_CLIENT_SECRET");

// Discord 상수
const DISCORD_CLIENT_ID = "1536191827705733191";
const DISCORD_GUILD_ID = "670629266328649749";
const DISCORD_ROLE_ID = "1462257396020809800";

function getBucket() {
  const bucketName = process.env.STORAGE_BUCKET || "ygo-synapse.firebasestorage.app";
  return admin.storage().bucket(bucketName);
}

function getStorageEmulatorBaseUrl() {
  const host = process.env.FIREBASE_STORAGE_EMULATOR_HOST || "127.0.0.1:5004";
  return `http://${host}`;
}

async function downloadProductionFile(objectPath) {
  const bucketName = process.env.STORAGE_BUCKET || "ygo-synapse.firebasestorage.app";
  if (process.env.FUNCTIONS_EMULATOR || process.env.FIREBASE_EMULATOR_HUB
      || process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_STORAGE_EMULATOR_HOST
      || process.env.FIREBASE_AUTH_EMULATOR_HOST) {
    throw new Error("로컬에서는 운영 API로 조회해야 합니다.");
  }
  const token = await admin.app().options.credential.getAccessToken();
  const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucketName)}/o/${encodeURIComponent(objectPath)}?alt=media`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token.access_token}` } });
  if (!response.ok) throw new Error(`운영 Storage 파일 조회 실패: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

module.exports = {
  admin,
  db,
  getBucket,
  getStorageEmulatorBaseUrl,
  downloadProductionFile,
  FieldValue,
  FieldPath,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REFRESH_TOKEN,
  DISCORD_BOT_TOKEN,
  DISCORD_CLIENT_SECRET,
  DISCORD_CLIENT_ID,
  DISCORD_GUILD_ID,
  DISCORD_ROLE_ID
};
