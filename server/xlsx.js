// A small, read-only .xlsx reader: enough to import the rate card
// (docs/model/sawa-rate-card.xlsx) without adding a spreadsheet dependency.
//
// An .xlsx file is a zip of XML parts. This reads the zip's central directory,
// inflates the parts it needs with node:zlib, and returns every sheet as rows
// of cell values. Formulas come back as their cached values (what Excel last
// computed), which is what the rate card's inputs and checks are. It supports
// the parts the rate card uses: shared strings, inline strings, numbers and
// booleans. It is not a general spreadsheet library.
import { inflateRawSync } from "node:zlib";

function unzip(buf) {
  // End of central directory: signature 0x06054b50, within the last 64 KB.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not an .xlsx file (no zip directory found)");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("damaged .xlsx file (bad directory entry)");
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(dataStart, dataStart + size);
    files.set(name, method === 8 ? inflateRawSync(raw) : method === 0 ? raw : null);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const decode = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&amp;/g, "&");
const textOf = (xml) => decode([...xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(""));

// "C12" → column index 2 (zero-based).
function colIndex(ref) {
  const letters = ref.replace(/\d+$/, "");
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// → [{ name, rows: [[value, …], …] }] in workbook order. Empty cells are null.
export function readXlsx(buffer) {
  const files = unzip(Buffer.from(buffer));
  const str = (name) => files.get(name)?.toString("utf8") || "";
  const shared = [...str("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]));
  const rels = new Map([...str("xl/_rels/workbook.xml.rels").matchAll(/<Relationship\b([^>]*)\/?>/g)]
    .map((m) => [/Id="([^"]+)"/.exec(m[1])?.[1], /Target="([^"]+)"/.exec(m[1])?.[1]]));
  const sheets = [...str("xl/workbook.xml").matchAll(/<sheet\b([^>]*)\/?>/g)].map((m) => ({
    name: decode(/name="([^"]*)"/.exec(m[1])?.[1] || ""),
    target: rels.get(/r:id="([^"]+)"/.exec(m[1])?.[1]),
  }));
  return sheets.map(({ name, target }) => {
    const path = target?.startsWith("/") ? target.slice(1) : `xl/${String(target).replace(/^\.\//, "")}`;
    const rows = [];
    for (const rm of str(path).matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
      const r = Number(/r="(\d+)"/.exec(rm[1])?.[1]) - 1;
      const row = [];
      for (const cm of rm[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = cm[1];
        const inner = cm[2] || "";
        const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1];
        const t = /t="([^"]+)"/.exec(attrs)?.[1];
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        let value = null;
        if (t === "s") value = v != null ? shared[Number(v)] ?? null : null;
        else if (t === "inlineStr") value = textOf(inner);
        else if (t === "str") value = v != null ? decode(v) : null;
        else if (t === "b") value = v === "1";
        else if (v != null && v !== "") value = Number(v);
        if (ref) row[colIndex(ref)] = value;
      }
      rows[r] = Array.from(row, (x) => (x === undefined ? null : x));
    }
    return { name, rows: Array.from(rows, (x) => x || []) };
  });
}
