import ChromeExtension from 'crx';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';

const zipPath = process.env.ZIP_PATH || './dist-zip/extension.zip';
const pemBase64 = process.env.CHROME_PEM_KEY;
const outputDir = process.env.OUTPUT_DIR || './dist-zip';

if (!pemBase64) {
  console.error('CHROME_PEM_KEY environment variable is required');
  process.exit(1);
}

const privateKey = Buffer.from(pemBase64, 'base64');

// crx v5 uses a class-based API
// Load manifest from the dist directory, use the zip file as contents
const crx = new ChromeExtension({ privateKey });

// Load the extension manifest from the directory
// (crx v5 `load` uses `rootDirectory`; pass the explicit path)
await crx.load(resolve('./dist'));

// Read the zip file to use as contents
const zipBuffer = readFileSync(resolve(zipPath));

// Pack the CRX using the zip contents
const crxBuffer = await crx.pack(zipBuffer);

if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
writeFileSync(resolve(outputDir, 'extension.crx'), crxBuffer);
console.log('✅ Chrome CRX generated successfully');