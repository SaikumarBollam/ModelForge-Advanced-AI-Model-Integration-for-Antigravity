import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Encrypted credential vault.
 *
 * - AES-256-GCM with a per-record random IV and auth tag.
 * - Key derived via scrypt from MODELFORGE_MASTER_KEY, or from a generated
 *   key file (0600) under the data dir when no env key is configured.
 * - On-disk format is versioned JSON so migrations stay backward compatible.
 * - Plaintext secrets are never logged and never returned by list operations.
 */

const VAULT_VERSION = 1;

interface EncryptedRecord {
  iv: string;
  tag: string;
  data: string;
}

interface VaultFile {
  version: number;
  salt: string;
  records: Record<string, EncryptedRecord>;
}

export class CredentialVault {
  private readonly filePath: string;
  private readonly key: Buffer;
  private vault: VaultFile;

  constructor(dataDir: string, masterKey?: string) {
    mkdirSync(dataDir, { recursive: true });
    this.filePath = join(dataDir, 'vault.json');

    let salt: Buffer;
    if (existsSync(this.filePath)) {
      this.vault = JSON.parse(readFileSync(this.filePath, 'utf8')) as VaultFile;
      if (this.vault.version !== VAULT_VERSION) {
        throw new Error(`Unsupported vault version ${this.vault.version}`);
      }
      salt = Buffer.from(this.vault.salt, 'base64');
    } else {
      salt = randomBytes(16);
      this.vault = { version: VAULT_VERSION, salt: salt.toString('base64'), records: {} };
    }

    const secret = masterKey ?? this.loadOrCreateKeyFile(dataDir);
    this.key = scryptSync(secret, salt, 32);
    if (!existsSync(this.filePath)) this.persist();
  }

  private loadOrCreateKeyFile(dataDir: string): string {
    const keyPath = join(dataDir, 'vault.key');
    if (existsSync(keyPath)) return readFileSync(keyPath, 'utf8').trim();
    const generated = randomBytes(32).toString('base64');
    writeFileSync(keyPath, generated, { mode: 0o600 });
    try { chmodSync(keyPath, 0o600); } catch { /* Windows ACLs differ; file is in user data dir */ }
    return generated;
  }

  private persist(): void {
    writeFileSync(this.filePath, JSON.stringify(this.vault, null, 2), { mode: 0o600 });
  }

  set(id: string, plaintext: string): void {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    this.vault.records[id] = {
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
    };
    this.persist();
  }

  get(id: string): string | undefined {
    const rec = this.vault.records[id];
    if (!rec) return undefined;
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(rec.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(rec.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(rec.data, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }

  delete(id: string): void {
    delete this.vault.records[id];
    this.persist();
  }

  has(id: string): boolean {
    return id in this.vault.records;
  }

  /** Masked hint safe for display: first 3 + last 4 chars, never the full secret. */
  hint(id: string): string | undefined {
    const value = this.get(id);
    if (!value) return undefined;
    if (value.length <= 8) return '••••••••';
    return `${value.slice(0, 3)}…${value.slice(-4)}`;
  }
}

/** Redact anything that looks like a credential from a string before logging. */
export function redactSecrets(text: string): string {
  return text
    .replace(/(authorization\s*:\s*bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/\b(sk|key|token|AKIA)[-_][A-Za-z0-9\-_]{8,}/g, '[REDACTED]')
    .replace(/("(?:api[_-]?key|secret|password|token)"\s*:\s*")[^"]+(")/gi, '$1[REDACTED]$2');
}

/** Constant-time-ish comparison for API keys (length leak is acceptable here). */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
