// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 참혈 (Chamhyul)
'use strict';

// Mechanical notice generation only. Reads package metadata and legal files,
// never application configuration, credentials, logs, or user data.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'public/legal');
const records = [];
const texts = new Map();
for (const base of ['', 'functions']) {
    const lockPath = path.join(base, 'package-lock.json');
    const lock = JSON.parse(fs.readFileSync(path.join(root, lockPath), 'utf8'));
    for (const [location, entry] of Object.entries(lock.packages)) {
        if (!location) continue;
        const directory = path.join(root, base, location);
        let pkg = {};
        try { pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')); } catch (_) {}
        const name = entry.name || location.split('node_modules/').pop();
        const installed = pkg.version === entry.version;
        const legalFiles = [];
        if (installed) {
            for (const file of fs.readdirSync(directory).sort()) {
                const nativeManifest = name.startsWith('@img/sharp-libvips-') && /^(README\.md|versions\.json)$/i.test(file);
                if (!nativeManifest && !/^(licen[sc]e|copying|notice|third[-_]?party[-_]?notices)([._-].*)?$/i.test(file)) continue;
                const full = path.join(directory, file);
                if (!fs.statSync(full).isFile()) continue;
                const text = fs.readFileSync(full, 'utf8');
                const hash = crypto.createHash('sha256').update(text).digest('hex');
                if (!texts.has(hash)) texts.set(hash, { text, packages: [] });
                texts.get(hash).packages.push(`${name}@${entry.version}: ${file}`);
                legalFiles.push({ file, sha256: hash });
            }
        }
        records.push({ lockfile: lockPath, location, name, version: entry.version,
            license: entry.license || pkg.license || (pkg.licenses || []).map(x => x.type).join(' OR ') || 'UNRESOLVED',
            dev: Boolean(entry.dev), optional: Boolean(entry.optional), installed,
            legalFiles, registry: `https://www.npmjs.com/package/${name}/v/${entry.version}` });
    }
}
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'npm-inventory.json'), JSON.stringify({
    description: 'Lockfile inventory, not a legal clearance. Uninstalled optional packages and packages without included notices need upstream review.',
    packages: records,
}, null, 2) + '\n');
fs.writeFileSync(path.join(out, 'npm-license-texts.txt'), [...texts.entries()].map(([hash, item]) =>
    `SHA256: ${hash}\n${[...new Set(item.packages)].sort().join('\n')}\n\n${item.text}\n`).join('\n\n'));
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(out, 'AGPL-3.0-only.txt'));
for (const file of ['THIRD_PARTY_NOTICES.md', 'ASSET_RIGHTS.md']) {
    // Rewrite root-relative documentation links for the hosted copy.
    const source = fs.readFileSync(path.join(root, file), 'utf8')
        .replace(/\]\(public\/legal\//g, '](')
        .replace(/\]\(LICENSE\)/g, '](AGPL-3.0-only.txt)');
    fs.writeFileSync(path.join(out, file), source);
}
console.log(JSON.stringify({ packages: records.length, licenseTexts: texts.size,
    unresolved: records.filter(r => r.license === 'UNRESOLVED').map(r => `${r.name}@${r.version}`),
    missingLocalNotices: records.filter(r => !r.legalFiles.length).length }, null, 2));
