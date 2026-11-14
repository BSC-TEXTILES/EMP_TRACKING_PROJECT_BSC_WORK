import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';

const BCRYPT_ROUNDS = 12;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** Cryptographically secure 6 digit OTP. */
export function generateOtp(): string {
  return String(crypto.randomInt(100000, 1000000));
}

export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function hashOtp(identifier: string, code: string): string {
  return sha256(`${identifier}:${code}`);
}

export function randomCode(length = 6): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += alphabet[crypto.randomInt(0, alphabet.length)];
  }
  return out;
}

export function passwordIssues(password: string): string[] {
  const issues: string[] = [];
  if (password.length < 10) issues.push('at least 10 characters');
  if (!/[A-Z]/.test(password)) issues.push('an uppercase letter');
  if (!/[a-z]/.test(password)) issues.push('a lowercase letter');
  if (!/[0-9]/.test(password)) issues.push('a number');
  if (!/[^A-Za-z0-9]/.test(password)) issues.push('a symbol');
  return issues;
}
