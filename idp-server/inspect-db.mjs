import Database from 'better-sqlite3';
import { assertPayload } from 'oidc-provider/lib/helpers/jwt.js';

const db = new Database('.data/idp.sqlite');
const row = db
  .prepare("SELECT data FROM oidc_store WHERE model='AuthorizationCode' ORDER BY rowid DESC LIMIT 1")
  .get();
const stored = JSON.parse(row.data);
console.log('keys:', Object.keys(stored).sort().join(','));
console.log('iat:', stored.iat, 'exp:', stored.exp, 'now:', Math.floor(Date.now() / 1000));
try {
  assertPayload(stored, { clockTolerance: 0 });
  console.log('assertPayload OK');
} catch (e) {
  console.log('assertPayload THROW:', e.message);
}
