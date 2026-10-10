'use strict';
const fs = require('node:fs');
const path = require('node:path');
const directory = process.env.TEST_WEB_ASSETS;
const manifest = directory ? JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8')) : {};
exports.fulfillTestWebAsset = async function fulfillTestWebAsset(route) {
  const asset = manifest[route.request().url()];
  if (!asset) return false;
  await route.fulfill({ contentType: asset.contentType, body: fs.readFileSync(path.join(directory, asset.filename)) });
  return true;
};
