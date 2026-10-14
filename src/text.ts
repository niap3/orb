// Byte and character helpers. Sizes are UTF-8 bytes; clips and splits are
// in characters (code points), never cutting one in half.

export function bytes(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/** The longest prefix of s that fits in max bytes. */
export function headBytes(s: string, max: number): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= max) return s;
  let end = max;
  // Step back over UTF-8 continuation bytes (10xxxxxx).
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf8");
}

/** Clip to head and tail, max characters in all. */
export function clip(s: string, max: number): string {
  const cs = Array.from(s);
  if (cs.length <= max) return s;
  const cut = cs.length - max;
  const note = `\n[... ${cut} characters clipped ...]\n`;
  const keep = Math.max(0, max - note.length);
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return cs.slice(0, head).join("") + note + (tail > 0 ? cs.slice(cs.length - tail).join("") : "");
}

/** Split into pieces of at most max characters. */
export function split(s: string, max: number): string[] {
  const cs = Array.from(s);
  if (cs.length <= max) return [s];
  const out: string[] = [];
  for (let k = 0; k < cs.length; k += max) out.push(cs.slice(k, k + max).join(""));
  return out;
}

/** One line of the view: newlines turned into spaces. */
export function flat(s: string): string {
  return s.replace(/\r?\n|\r/g, " ");
}
