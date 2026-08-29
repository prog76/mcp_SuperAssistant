import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { createHash } from 'crypto';
import { resolve } from 'path';

const version = process.env.RELEASE_VERSION;
const repo = process.env.GITHUB_REPOSITORY;
const addonId = process.env.FIREFOX_ADDON_ID || 'prog76@mcpsuperassistant.ai';
const xpiPath = process.env.XPI_PATH || './dist-zip/extension-firefox.xpi';
const outputDir = process.env.OUTPUT_DIR || './dist-zip';

if (!version || !repo) {
  console.error('Missing RELEASE_VERSION or GITHUB_REPOSITORY');
  process.exit(1);
}

const xpiUrl = `https://github.com/${repo}/releases/download/v${version}/extension-firefox.xpi`;

// Compute sha256 hash of the xpi for integrity verification (recommended by Mozilla)
let updateHash = '';
try {
  const xpiBuffer = readFileSync(resolve(xpiPath));
  const hash = createHash('sha256').update(xpiBuffer).digest('hex');
  updateHash = `sha256:${hash}`;
} catch {
  console.warn('⚠️ Could not read XPI for hash computation; update_hash will be omitted');
}

const manifest = {
  addons: {
    [addonId]: {
      updates: [
        {
          version,
          update_link: xpiUrl,
          ...(updateHash && { update_hash: updateHash }),
        },
      ],
    },
  },
};

if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
const outPath = resolve(outputDir, 'firefox-updates.json');
writeFileSync(outPath, JSON.stringify(manifest, null, 2));
console.log(`✅ firefox-updates.json generated for v${version}`);
console.log(`   update_link: ${xpiUrl}`);
if (updateHash) console.log(`   update_hash: ${updateHash}`);