import crypto from 'crypto';

const pem = process.argv[2] || process.env.CHROME_PEM_KEY;
if (!pem) {
  console.error('Provide PEM key as argument or set CHROME_PEM_KEY env');
  process.exit(1);
}

const key = Buffer.from(pem, 'base64');
const pubKey = crypto.createPublicKey(key);
const der = pubKey.export({ type: 'spki', format: 'der' });
const hash = crypto.createHash('sha256').update(der).digest();
const appId = Buffer.from(hash)
  .toString('base64')
  .replace(/[=]/g, '')
  .replace(/\+/g, '-')
  .replace(/\//g, '_')
  .substring(0, 32);

console.log(appId);