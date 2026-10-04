import https from "node:https";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

const TIMEOUT_MS = 45_000;
const MAX_REDIRECTS = 3;

const excluded = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) excluded.addSubnet(address, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
for (const [address, prefix] of [
  ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20],
] as const) excluded.addSubnet(address, prefix, "ipv6");

/** Refuse private, loopback, link-local, multicast and special-use destinations. */
export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) return !excluded.check(address, "ipv4");
  if (isIP(address) === 6) return globalV6.check(address, "ipv6") && !excluded.check(address, "ipv6");
  return false;
}

export function validateDownloadUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("Invalid file download URL"); }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) {
    throw new Error("File downloads require HTTPS on port 443 without URL credentials");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (!hostname || (isIP(hostname) && !isPublicAddress(hostname)) ||
      hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new Error("File downloads cannot target local or private hosts");
  }
  return url;
}

export interface DownloadedFile { data: Buffer; mimeType: string; }
interface Hop { redirect?: string; data?: Buffer; mimeType?: string; }

async function downloadHop(url: URL, maxBytes: number, signal: AbortSignal): Promise<Hop> {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  signal.throwIfAborted();
  if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address))) {
    throw new Error("Download host resolved to a non-public address");
  }
  const pinned = addresses.find((a) => a.family === 4) ?? addresses[0];
  return new Promise((resolve, reject) => {
    // Pin the already-validated IP for the TCP connection. Preserve the original
    // hostname for HTTP Host, TLS SNI and certificate verification (no DNS rebinding).
    const req = https.request({
      protocol: "https:", hostname: pinned.address, family: pinned.family, port: 443,
      servername: isIP(hostname) ? undefined : hostname,
      path: url.pathname + url.search, method: "GET", agent: false, signal,
      headers: { Host: url.host, "Accept-Encoding": "identity", "User-Agent": "remote-sandbox-mcp-file-upload/1" },
    }, (res) => {
      const status = res.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        const redirect = res.headers.location;
        res.destroy();
        if (!redirect) reject(new Error("File download redirect has no destination"));
        else resolve({ redirect });
        return;
      }
      if (status !== 200) {
        res.destroy();
        reject(new Error(`File download returned HTTP ${status}; the temporary link may have expired. Pass the file again.`));
        return;
      }
      const length = res.headers["content-length"];
      if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
        res.destroy(); reject(new Error(`File exceeds the ${maxBytes}-byte limit`)); return;
      }
      const encoding = res.headers["content-encoding"];
      if (encoding && encoding !== "identity") {
        res.destroy(); reject(new Error("Unexpected compressed HTTP response")); return;
      }
      let size = 0;
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          res.destroy(); reject(new Error(`File exceeds the ${maxBytes}-byte limit`));
        } else chunks.push(chunk);
      });
      res.on("error", () => reject(new Error("File download stream failed")));
      res.on("aborted", () => reject(new Error("File download was interrupted")));
      res.on("end", () => resolve({
        data: Buffer.concat(chunks),
        mimeType: (res.headers["content-type"] ?? "application/octet-stream").split(";")[0].trim(),
      }));
    });
    req.on("error", () => reject(new Error(signal.aborted ? "File download timed out" : "File download connection failed")));
    req.end();
  });
}

/** Download bounded bytes. Never include a signed URL in logs, errors or results. */
export async function downloadFile(raw: string, maxBytes: number): Promise<DownloadedFile> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Invalid file size limit");
  let current = validateDownloadUrl(raw);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error("File download timed out")); }, TIMEOUT_MS);
    timer.unref();
  });
  try {
    return await Promise.race([timeout, (async () => {
      for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
        const result = await downloadHop(current, maxBytes, controller.signal);
        if (!result.redirect) return { data: result.data!, mimeType: result.mimeType! };
        if (redirects === MAX_REDIRECTS) throw new Error("Too many file download redirects");
        let next: URL;
        try { next = new URL(result.redirect, current); } catch { throw new Error("Invalid download redirect"); }
        current = validateDownloadUrl(next.href);
      }
      throw new Error("File download did not complete");
    })()]);
  } catch (e) {
    // DNS exceptions can contain the hostname. No request URL/query is returned.
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") throw new Error("File download host could not be resolved");
    throw e;
  } finally {
    clearTimeout(timer!);
    controller.abort();
  }
}
