const { onRequest: firebaseOnRequest } = require("firebase-functions/v2/https");
const { withPublicReadRequest } = require("../services/publicReadTransport");
const onRequest = (options, handler) => firebaseOnRequest(options, withPublicReadRequest(handler));
const { getBucket, getStorageEmulatorBaseUrl } = require("../config/firebase");
const { setCors, verifyAppCheck } = require("../utils/auth");

const { createCardResourcesReader } = require('../services/cardResources');
const readCardResources = createCardResourcesReader({ getBucket, getStorageEmulatorBaseUrl,
  isEmulator: () => process.env.FUNCTIONS_EMULATOR === 'true' });

exports.getInitialData = onRequest({ invoker: "public", memory: "256MiB" }, async (req, res) => {
  setCors(res, req);
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (!(await verifyAppCheck(req, res))) return;

  try {
    const resources = globalThis.process?.env?.CARD_SERVICE_URL
      ? await require('../services/cardReadClient').getCardReadClient().readResources() : await readCardResources();

    return res.json({
      success: true,
      schemaVersion: 2,
      syncType: "storage-links",
      serverTime: Date.now(),
      resources,
    });
  } catch (e) {
    console.error("getInitialData error:", e);
    return res.status(500).json({ success: false, message: e.toString() });
  }
});

