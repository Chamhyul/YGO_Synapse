const admin = require("firebase-admin");
const { FieldValue } = require("firebase-admin/firestore");
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

module.exports = {
  admin,
  db,
  getBucket,
  FieldValue,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REFRESH_TOKEN,
  DISCORD_BOT_TOKEN,
  DISCORD_CLIENT_SECRET,
  DISCORD_CLIENT_ID,
  DISCORD_GUILD_ID,
  DISCORD_ROLE_ID
};
