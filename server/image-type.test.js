import { test } from "node:test";
import assert from "node:assert/strict";
import { sniffImageType } from "./image-type.js";

const pad = (bytes) => Buffer.concat([Buffer.from(bytes), Buffer.alloc(16)]);

test("each accepted image type is recognised from its first bytes", () => {
  assert.equal(sniffImageType(pad([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(sniffImageType(pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "image/png");
  assert.equal(sniffImageType(Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(16)])), "image/gif");
  assert.equal(sniffImageType(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(8)])), "image/webp");
});

test("anything else is not an image, whatever it was declared as", () => {
  assert.equal(sniffImageType(Buffer.from("<html><script>alert(1)</script></html>")), null);
  assert.equal(sniffImageType(Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>")), null);
  assert.equal(sniffImageType(Buffer.from("%PDF-1.7 not an image at all")), null);
  assert.equal(sniffImageType(Buffer.alloc(0)), null);
  assert.equal(sniffImageType(null), null);
});
