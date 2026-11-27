import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface StoredCredential {
  readonly accountId: string;
  readonly platform: string;
  readonly owner: string;
  readonly secret: string;
}
export interface CredentialMeta {
  readonly accountId: string;
  readonly platform: string;
  readonly owner: string;
}

const ID = /^[A-Za-z0-9_.:-]{1,80}$/;
const IV_LEN = 12;
const TAG_LEN = 16;

function keyFor(passphrase: string, dir: string): Buffer {
  const saltPath = join(dir, 'salt.bin');
  let salt: Buffer;
  if (existsSync(saltPath)) salt = readFileSync(saltPath);
  else { salt = randomBytes(16); writeFileSync(saltPath, salt, { mode: 0o600 }); try { chmodSync(saltPath, 0o600); } catch { /* best effort on non-POSIX */ } }
  return scryptSync(passphrase, salt, 32);
}

/** Encrypted credential store. Secrets are AES-256-GCM encrypted at rest; never written in plaintext. */
export class LocalCredentialStore {
  private readonly dir: string;
  private readonly key: Buffer;
  constructor(options: { dir: string; passphrase: string }) {
    if (!options || typeof options.dir !== 'string' || !options.dir) throw new Error('checkin_store_dir_required');
    if (typeof options.passphrase !== 'string' || options.passphrase.length < 8) throw new Error('checkin_passphrase_weak');
    this.dir = resolve(options.dir);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.key = keyFor(options.passphrase, this.dir);
  }
  private fileFor(accountId: string, platform: string): string {
    if (!ID.test(accountId) || !ID.test(platform) || accountId.includes('..') || platform.includes('..')) throw new Error('checkin_store_key_invalid');
    return join(this.dir, platform + '__' + accountId + '.enc');
  }
  put(cred: StoredCredential): void {
    if (!ID.test(cred.accountId) || !ID.test(cred.platform) || typeof cred.secret !== 'string' || !cred.secret) throw new Error('checkin_store_credential_invalid');
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const plaintext = Buffer.from(JSON.stringify({ accountId: cred.accountId, platform: cred.platform, owner: cred.owner, secret: cred.secret }), 'utf8');
    const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    const blob = Buffer.concat([iv, tag, data]).toString('base64');
    const file = this.fileFor(cred.accountId, cred.platform);
    writeFileSync(file, blob, { mode: 0o600 });
    try { chmodSync(file, 0o600); } catch { /* best effort */ }
  }
  get(accountId: string, platform: string): StoredCredential {
    const file = this.fileFor(accountId, platform);
    if (!existsSync(file)) throw new Error('checkin_credential_missing');
    const raw = Buffer.from(readFileSync(file, 'utf8'), 'base64');
    if (raw.length < IV_LEN + TAG_LEN) throw new Error('checkin_credential_corrupt');
    const iv = raw.subarray(0, IV_LEN);
    const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const data = raw.subarray(IV_LEN + TAG_LEN);
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    let parsed: unknown;
    try { parsed = JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')); }
    catch { throw new Error('checkin_credential_decrypt_failed'); }
    const rec = parsed as Record<string, unknown>;
    if (!rec || typeof rec.secret !== 'string' || typeof rec.accountId !== 'string' || typeof rec.platform !== 'string' || typeof rec.owner !== 'string') {
      throw new Error('checkin_credential_invalid');
    }
    return { accountId: rec.accountId, platform: rec.platform, owner: rec.owner, secret: rec.secret };
  }
  list(): readonly CredentialMeta[] {
    return Object.freeze(readdirSync(this.dir)
      .filter((name) => name.endsWith('.enc'))
      .map((name) => {
        const [platform, accountPart] = name.slice(0, -4).split('__');
        const accountId = accountPart ?? '';
        try { const c = this.get(accountId, platform); return { accountId: c.accountId, platform: c.platform, owner: c.owner }; }
        catch { return { accountId, platform, owner: 'unknown' }; }
      }));
  }
}
