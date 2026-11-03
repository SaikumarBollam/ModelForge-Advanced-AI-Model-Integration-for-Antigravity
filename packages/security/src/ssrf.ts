import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * SSRF guard for upstream base URLs.
 *
 * Policy:
 * - Only http:/https: URLs.
 * - Loopback/private targets are allowed only when explicitly enabled
 *   (required for legitimate local inference servers such as Ollama).
 * - When private targets are disabled, hostnames are resolved and every
 *   resolved address must be public. (DNS-rebinding TOCTOU is mitigated by
 *   re-validating at connect time in deployments that need it; documented.)
 */

export interface SsrfOptions {
  allowPrivate: boolean;
}

function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a = 0, b = 0] = ip.split('.').map(Number);
    return (
      a === 10 || a === 127 || a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }
  const lower = ip.toLowerCase();
  return lower === '::1' || lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd');
}

export async function assertSafeUpstreamUrl(raw: string, opts: SsrfOptions): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported URL protocol: ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new Error('Credentials embedded in URLs are not allowed');
  }
  const host = url.hostname;
  if (isIP(host)) {
    if (isPrivateIp(host) && !opts.allowPrivate) {
      throw new Error(`Private/loopback upstream ${host} is disabled by policy`);
    }
    return url;
  }
  if (!opts.allowPrivate) {
    const addresses = await lookup(host, { all: true });
    for (const { address } of addresses) {
      if (isPrivateIp(address)) {
        throw new Error(`Hostname ${host} resolves to private address ${address}`);
      }
    }
  }
  return url;
}
