import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CredentialVault, redactSecrets } from './vault.js';
import { assertSafeUpstreamUrl } from './ssrf.js';

describe('CredentialVault', () => {
  it('round-trips secrets and never stores plaintext on disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mf-vault-'));
    const vault = new CredentialVault(dir, 'test-master-key-with-enough-entropy');
    vault.set('conn-1', 'sk-super-secret-value-1234');
    expect(vault.get('conn-1')).toBe('sk-super-secret-value-1234');
    expect(vault.has('conn-1')).toBe(true);
    expect(vault.hint('conn-1')).toBe('sk-…1234');
    const raw = readFileSync(join(dir, 'vault.json'), 'utf8');
    expect(raw).not.toContain('sk-super-secret-value-1234');
    // A fresh instance with the same master key can decrypt.
    const reopened = new CredentialVault(dir, 'test-master-key-with-enough-entropy');
    expect(reopened.get('conn-1')).toBe('sk-super-secret-value-1234');
    vault.delete('conn-1');
    expect(vault.get('conn-1')).toBeUndefined();
  });

  it('fails to decrypt with the wrong master key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mf-vault-'));
    new CredentialVault(dir, 'correct-key-0123456789abcdef').set('c', 'secret-value-here');
    expect(() => new CredentialVault(dir, 'wrong-key-0123456789abcdef00').get('c')).toThrow();
  });
});

describe('redactSecrets', () => {
  it('redacts bearer tokens and key-shaped strings', () => {
    expect(redactSecrets('Authorization: Bearer abcdefghijklmnop')).not.toContain('abcdefghijklmnop');
    expect(redactSecrets('{"api_key":"hunter2hunter2"}')).not.toContain('hunter2hunter2');
  });
});

describe('assertSafeUpstreamUrl', () => {
  it('rejects non-http protocols and embedded credentials', async () => {
    await expect(assertSafeUpstreamUrl('file:///etc/passwd', { allowPrivate: true })).rejects.toThrow();
    await expect(assertSafeUpstreamUrl('https://user:pass@api.example.com', { allowPrivate: true })).rejects.toThrow();
  });
  it('blocks loopback when private upstreams are disabled', async () => {
    await expect(assertSafeUpstreamUrl('http://127.0.0.1:11434', { allowPrivate: false })).rejects.toThrow(/disabled/);
    await expect(assertSafeUpstreamUrl('http://127.0.0.1:11434', { allowPrivate: true })).resolves.toBeInstanceOf(URL);
  });
});
