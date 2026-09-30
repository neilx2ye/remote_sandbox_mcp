/** Detect likely-binary content by scanning for NUL bytes / control chars. */
export function looksBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 8192));
  for (let i = 0; i < sample.length; i++) {
    const b = sample[i];
    if (b === 0) return true;
  }
  return false;
}

/** Append line numbers, 1-based, one per line: "12\tcontent". */
export function withLineNumbers(text: string, startLine = 1): string {
  const lines = text.split("\n");
  return lines.map((l, i) => `${startLine + i}\t${l}`).join("\n");
}

export interface PagedText {
  text: string;
  totalLines: number;
  startLine: number;
  endLine: number;
  truncated: boolean;
}

/**
 * Extract a 1-based line page [offset, offset+limit) from text.
 * offset=0 means start from line 1.
 */
export function pageLines(text: string, offset = 0, limit?: number): PagedText {
  const lines = text.split("\n");
  const total = lines.length;
  const start = Math.max(0, offset);
  const end = limit === undefined ? total : Math.min(total, start + Math.max(0, limit));
  const slice = lines.slice(start, end);
  return {
    text: withLineNumbers(slice.join("\n"), start + 1),
    totalLines: total,
    startLine: start + 1,
    endLine: end,
    truncated: end < total,
  };
}

/** Truncate a string to maxBytes of UTF-8, appending a marker if truncated. */
export function truncateUtf8(s: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= maxBytes) return { text: s, truncated: false };
  const sliced = buf.subarray(0, maxBytes).toString("utf8");
  return { text: sliced + `\n...[truncated at ${maxBytes} bytes]`, truncated: true };
}
