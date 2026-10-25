import { describe, expect, it } from "vitest";
import { isIP as nodeIsIP } from "node:net";
import { isIP } from "../../src/platform/netIsIp";

const samples = [
  "127.0.0.1",
  "0.0.0.0",
  "255.255.255.255",
  "256.1.1.1",
  "1.2.3",
  "1.2.3.4.5",
  "01.2.3.4",
  "1.2.3.04",
  "a.b.c.d",
  "",
  "::1",
  "::",
  "1::",
  "2001:db8::1",
  "2001:0db8:0000:0000:0000:0000:0000:0001",
  "1:2:3:4:5:6:7:8",
  "1:2:3:4:5:6:7",
  "1:2:3:4:5:6:7:8:9",
  "::ffff:192.168.1.1",
  "::ffff:300.1.1.1",
  "fe80::1%eth0",
  "fe80::1%",
  "1::2::3",
  "12345::1",
  "g::1",
  ":::",
  "1:2:3:4:5:6:7::",
  "::1:2:3:4:5:6:7",
  "not an ip",
  "1.1.1.1 ",
  " 1.1.1.1",
];

describe("netIsIp adapter", () => {
  it.each(samples)("agrees with node:net isIP for %j", (s) => {
    expect(isIP(s)).toBe(nodeIsIP(s));
  });
});
