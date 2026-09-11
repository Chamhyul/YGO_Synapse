const admin = require("firebase-admin");
const fs = require("node:fs");
const path = require("node:path");
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

function getProductionBucket() {
  const bucketName = process.env.STORAGE_BUCKET || "ygo-synapse.firebasestorage.app";
  const isEmulator = process.env.FUNCTIONS_EMULATOR || process.env.FIREBASE_EMULATOR_HUB;
  if (!isEmulator) return getBucket();

  const appName = "production-storage-v2";
  let productionApp = admin.apps.find(app => app.name === appName);
  if (!productionApp) {
    const keyPath = path.resolve(__dirname, "../serviceAccountKey.json");
    if (!fs.existsSync(keyPath)) {
      throw new Error("로컬 이미지 검색을 위한 운영 Storage 서비스 계정이 없습니다.");
    }
    const serviceAccount = JSON.parse(fs.readFileSync(keyPath, "utf8"));
    productionApp = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      storageBucket: bucketName,
    }, appName);
  }
  // firebase-tools sets this globally for the default app. Temporarily remove it
  // only while the secondary Storage client is created so this client targets GCS.
  const emulatorHost = process.env.FIREBASE_STORAGE_EMULATOR_HOST;
  delete process.env.FIREBASE_STORAGE_EMULATOR_HOST;
  try {
    return admin.storage(productionApp).bucket(bucketName);
  } finally {
    if (emulatorHost) process.env.FIREBASE_STORAGE_EMULATOR_HOST = emulatorHost;
  }
}

function getProductionCredential() {
  const isEmulator = process.env.FUNCTIONS_EMULATOR || process.env.FIREBASE_EMULATOR_HUB;
  if (!isEmulator) return admin.app().options.credential;
  const appName = "production-storage-auth";
  let productionApp = admin.apps.find(app => app.name === appName);
  if (!productionApp) {
    const keyPath = path.resolve(__dirname, "../serviceAccountKey.json");
    if (!fs.existsSync(keyPath)) throw new Error("로컬 이미지 검색을 위한 운영 Storage 서비스 계정이 없습니다.");
    productionApp = admin.initializeApp({ credential: admin.credential.cert(JSON.parse(fs.readFileSync(keyPath, "utf8"))) }, appName);
  }
  return productionApp.options.credential;
}

async function downloadProductionFile(objectPath) {
  const bucketName = process.env.STORAGE_BUCKET || "ygo-synapse.firebasestorage.app";
  const token = await getProductionCredential().getAccessToken();
  const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucketName)}/o/${encodeURIComponent(objectPath)}?alt=media`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token.access_token}` } });
  if (!response.ok) throw new Error(`운영 Storage 파일 조회 실패: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

module.exports = {
  admin,
  db,
  getBucket,
  getProductionBucket,
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
