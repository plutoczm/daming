import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** RFC 4226/6238 compatible 6-digit TOTP, 30-second steps, SHA-1. */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function createTotpSecret(): string {
  const bytes = randomBytes(20);
  let bits = 0, value = 0, result = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      result += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) result += ALPHABET[(value << (5 - bits)) & 31];
  bytes.fill(0);
  return result;
}
function base32Decode(secret: string): Buffer {
  if (!/^[A-Z2-7]{32}$/.test(secret)) throw new Error('totp_secret_invalid');
  const result: number[] = [];
  let value = 0, bits = 0;
  for (const character of secret) {
    value = (value << 5) | ALPHABET.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      result.push((value >>> bits) & 255);
    }
  }
  return Buffer.from(result);
}
export function totpCode(secret: string, step: number): string {
  if (!Number.isSafeInteger(step) || step < 0) throw new Error('totp_step_invalid');
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const key = base32Decode(secret);
  try {
    const digest = createHmac('sha1', key).update(counter).digest();
    const offset = digest[digest.length - 1] & 15;
    const binary = ((digest[offset] & 127) << 24) |
      (digest[offset + 1] << 16) |
      (digest[offset + 2] << 8) |
      digest[offset + 3];
    return (binary % 1000000).toString().padStart(6, '0');
  } finally { key.fill(0); }
}

/** Returns the consumed step, never a boolean permit that can be replayed. */
export function verifyTotp(secret: string, code: unknown, nowMs: number, afterStep: number): number | null {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code) ||
      !Number.isSafeInteger(nowMs) || nowMs < 0 || !Number.isSafeInteger(afterStep)) return null;
  const current = Math.floor(nowMs / 30000);
  const submitted = Buffer.from(code, 'utf8');
  for (const step of [current - 1, current, current + 1]) {
    if (step < 0 || step <= afterStep) continue;
    const expected = Buffer.from(totpCode(secret, step), 'utf8');
    if (timingSafeEqual(submitted, expected)) return step;
  }
  return null;
}

export function totpEnrollmentUri(username: string, secret: string): string {
  return 'otpauth://totp/' + encodeURIComponent('Daming:' + username) +
    '?secret=' + secret + '&issuer=Daming&algorithm=SHA1&digits=6&period=30';
}
