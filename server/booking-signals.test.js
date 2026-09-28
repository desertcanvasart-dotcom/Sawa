// The reservation signals are reduced before they are stored (decided 28 Sep
// 2026): never a raw fingerprint, IP address or phone number.
import { test } from "node:test";
import assert from "node:assert/strict";
import { deviceHash, ipPrefix, phoneCountryCode } from "./booking-signals.js";

test("the IP address is cut to its /24 (IPv6: /48)", () => {
  assert.equal(ipPrefix("41.33.12.7"), "41.33.12.0/24");
  assert.equal(ipPrefix("::ffff:41.33.12.200"), "41.33.12.0/24");
  assert.equal(ipPrefix("2001:0db8:0001:0002::5"), "2001:db8:1::/48");
  assert.equal(ipPrefix("2001:db8:1:2:3:4:5:6"), "2001:db8:1::/48");
  assert.equal(ipPrefix(""), null);
  assert.equal(ipPrefix("not-an-ip"), null);
});

test("the phone keeps only its country calling code", () => {
  assert.equal(phoneCountryCode("+20 100 111 2233"), "+20");
  assert.equal(phoneCountryCode("0044 7700 900123"), "+44");
  assert.equal(phoneCountryCode("+1 (415) 555-0100"), "+1");
  assert.equal(phoneCountryCode("+971 50 123 4567"), "+971");
  assert.equal(phoneCountryCode("01001112233"), null, "a number without its country code gives no signal");
});

test("the device fingerprint is a salted hash, stable for the same browser", () => {
  const a = deviceHash({ userAgent: "UA", language: "en", hint: "1920|1080" }, "salt");
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.equal(a, deviceHash({ userAgent: "UA", language: "en", hint: "1920|1080" }, "salt"));
  assert.notEqual(a, deviceHash({ userAgent: "UA", language: "en", hint: "1920|1080" }, "other salt"));
  assert.notEqual(a, deviceHash({ userAgent: "UA", language: "en", hint: "1280|800" }, "salt"));
  assert.ok(!a.includes("UA"));
  assert.equal(deviceHash({}), null);
});
