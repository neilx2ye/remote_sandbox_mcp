import { describe, expect, it } from "vitest";
import { isPublicAddress, validateDownloadUrl, downloadFile } from "../src/util/file-download.js";

describe("file download destination checks", () => {
  it.each(["8.8.8.8", "1.1.1.1", "104.18.33.45", "2606:4700:4700::1111", "2001:4860:4860::8888"])("accepts ordinary public IP %s", (ip) => {
    expect(isPublicAddress(ip)).toBe(true);
  });
  it.each(["0.0.0.0", "10.0.0.1", "127.0.0.1", "100.64.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.0.1", "192.0.0.1", "192.0.2.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "255.255.255.255", "::", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "fc00::1", "fe80::1", "ff02::1", "2001:db8::1", "2001:0db8::1", "2001:20::1", "2002:7f00:1::", "3fff:1::1", "not-an-ip"])("rejects non-public/special IP %s", (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });
  it("accepts a signed HTTPS URL without modifying its query", () => {
    const input = "https://example.com/file.png?sig=a%2Bb&expires=123";
    expect(validateDownloadUrl(input).href).toBe(input);
  });
  it.each(["http://example.com/a", "file:///etc/passwd", "data:image/png,abc", "https://user:pass@example.com/a", "https://example.com:8443/a", "https://localhost/a", "https://service.local/a", "https://127.0.0.1/a", "https://2130706433/a", "https://0x7f000001/a", "https://[::1]/a", "https://[::ffff:127.0.0.1]/a"])("rejects unsafe URL %s", (url) => {
    expect(() => validateDownloadUrl(url)).toThrow();
  });
  it("does not expose credentials in validation errors", () => {
    try { validateDownloadUrl("https://secret:password@localhost/image?token=secret"); }
    catch (e) { expect((e as Error).message).not.toContain("secret"); }
  });
  it("rejects a private URL without opening a network connection", async () => {
    await expect(downloadFile("https://169.254.169.254/latest/meta-data/", 1024)).rejects.toThrow("private");
  });
  it.each([0, -1, Infinity, Number.NaN, 0.5])("rejects invalid byte limit %s", async (limit) => {
    await expect(downloadFile("https://example.com/file", limit)).rejects.toThrow("size limit");
  });
});
