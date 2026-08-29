import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve } from 'path';

const version = process.env.RELEASE_VERSION;
const repo = process.env.GITHUB_REPOSITORY;
const appId = process.env.CHROME_APP_ID;
const outputDir = process.env.OUTPUT_DIR || './dist-zip';

if (!version || !repo || !appId) {
  console.error('Missing RELEASE_VERSION, GITHUB_REPOSITORY, or CHROME_APP_ID');
  process.exit(1);
}

const xml = `<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/update' protocol='2.0'>
  <app appid='${appId}'>
    <updatecheck codebase='https://github.com/${repo}/releases/download/v${version}/extension.crx' version='${version}' />
  </app>
</gupdate>`;

if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
writeFileSync(resolve(outputDir, 'update.xml'), xml);
console.log(`✅ update.xml generated for v${version}`);