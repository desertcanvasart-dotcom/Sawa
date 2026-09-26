// Receipt files for cost lines — the rules, without storage.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseReceiptDataUrl, receiptKey, mayAttachReceipt, receiptDisplayName, isReceiptRef, RECEIPT_MAX_BYTES,
} from "./receipts.js";

const b64 = (bytes) => Buffer.alloc(bytes, 1).toString("base64");

test("PDFs and photos are accepted; anything else, empty or oversized files are not", () => {
  for (const type of ["application/pdf", "image/jpeg", "image/png", "image/webp", "image/heic"]) {
    const r = parseReceiptDataUrl(`data:${type};base64,${b64(10)}`);
    assert.ok(!r.error, type);
    assert.equal(r.buffer.length, 10);
  }
  assert.equal(parseReceiptDataUrl(`data:image/jpg;base64,${b64(10)}`).contentType, "image/jpeg");
  assert.match(parseReceiptDataUrl(`data:text/html;base64,${b64(10)}`).error, /PDF or a photo/);
  assert.match(parseReceiptDataUrl(`data:image/svg+xml;base64,${b64(10)}`).error, /PDF or a photo/, "no SVG — it can carry script");
  assert.match(parseReceiptDataUrl("nonsense").error, /No file/);
  assert.match(parseReceiptDataUrl(`data:application/pdf;base64,${b64(RECEIPT_MAX_BYTES + 1)}`).error, /8MB/);
});

test("keys sit under their uploader, with the file's name kept for display", () => {
  const k = receiptKey({ agencyId: "ag_life", filename: "Coach Contract (Oct).PDF", ext: "pdf", now: 1, rand: "abc123" });
  assert.equal(k, "agency/ag_life/1-abc123-coach-contract-oct.pdf");
  assert.equal(receiptKey({ filename: "", ext: "jpg", now: 1, rand: "x" }), "sawa/1-x-receipt.jpg");
  assert.equal(receiptDisplayName(`receipts:${k}`), "coach-contract-oct.pdf");
});

test("an agency attaches only its own uploads; staff attach any", () => {
  const mine = "receipts:agency/ag_life/1-abc-coach.pdf";
  assert.equal(mayAttachReceipt(mine, { agencyId: "ag_life" }), true);
  assert.equal(mayAttachReceipt(mine, { agencyId: "ag_other" }), false, "another agency's file");
  assert.equal(mayAttachReceipt(mine, { staff: true }), true);
  assert.equal(mayAttachReceipt("receipts:sawa/1-abc-x.pdf", { agencyId: "ag_life" }), false);
  for (const bad of ["receipts:../../tour-images/x.jpg", "receipts:agency/ag_life/../x.pdf", "receipts:agency/ag_life/x.exe", "https://x.com/a.pdf"]) {
    assert.equal(mayAttachReceipt(bad, { staff: true }), false, bad);
  }
  assert.equal(isReceiptRef("https://drive.example.com/r"), false);
});
