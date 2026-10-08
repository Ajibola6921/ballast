/**
 * Subscribers choose the URL we POST to, so the API must not be usable to reach its own network.
 * A URL is accepted only if it is https (http only outside production), carries no credentials,
 * and every address its host resolves to is publicly routable. This is checked when a
 * subscription is created and again right before each delivery, because DNS can change in between.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class UnsafeWebhookUrlError extends Error {}

export type ResolveAll = (hostname: string) => Promise<string[]>;

const defaultResolve: ResolveAll = async (hostname) =>
  (await lookup(hostname, { all: true })).map((r) => r.address);

function ipv4Private(ip: string): boolean {
  const [a, b, c] = ip.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, incl. cloud metadata 169.254.169.254
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224 // multicast and reserved
  );
}

export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return ipv4Private(ip);
  if (kind === 6) {
    const lower = ip.toLowerCase();
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return ipv4Private(mapped[1]);
    return (
      lower === "::" ||
      lower === "::1" ||
      /^f[cd]/.test(lower) || // unique local fc00::/7
      /^fe[89ab]/.test(lower) || // link-local fe80::/10
      lower.startsWith("ff") // multicast
    );
  }
  return true; // not an IP at all: refuse
}

const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa"];

export async function assertSafeWebhookUrl(
  raw: string,
  { allowHttp = false, resolve = defaultResolve }: { allowHttp?: boolean; resolve?: ResolveAll } = {},
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeWebhookUrlError("not a valid URL");
  }
  if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) {
    throw new UnsafeWebhookUrlError("webhook URL must use https");
  }
  if (url.username || url.password) throw new UnsafeWebhookUrlError("webhook URL must not contain credentials");

  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new UnsafeWebhookUrlError("webhook URL points at a local hostname");
  }

  const addresses = isIP(host) ? [host] : await resolve(host).catch(() => []);
  if (addresses.length === 0) throw new UnsafeWebhookUrlError("webhook host does not resolve");
  if (addresses.some(isPrivateAddress)) {
    throw new UnsafeWebhookUrlError("webhook URL resolves to a private or reserved address");
  }
  return url;
}
