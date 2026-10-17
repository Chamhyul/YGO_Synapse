const { forwardAdminRequest } = require('../../services/adminActionTransport');
const { onRequest } = require("firebase-functions/v2/https");
const { setCors, verifyAdmin } = require("../../utils/auth");
const { startCardNumbersMigration } = require("../../services/cardNumbersMigrationService");

exports.migrateCardNumbersField = onRequest({ invoker: "public", memory: "256MiB", timeoutSeconds: 30 }, async (req, res) => {
  setCors(res, req);
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (await forwardAdminRequest(req, res, 'migrateCardNumbersField')) return;
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, message: "Method Not Allowed. Use POST." });
  }

  if (!(await verifyAdmin(req, res))) return;

  const { httpStatus, ...result } = await startCardNumbersMigration();
  return res.status(httpStatus).json(result);

});

