import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import { resolveLicenseListenHost } from "../src/infrastructure/config/licenseListenHost.ts";

const here = dirname(fileURLToPath(import.meta.url));

describe("DFP-030 license-server loopback privilege isolation", () => {
  it("forces loopback listen host when openLoopback is enabled", () => {
    expect(resolveLicenseListenHost(true, "0.0.0.0").listenHost).toBe("127.0.0.1");
    expect(resolveLicenseListenHost(true, "127.0.0.1").listenHost).toBe("127.0.0.1");
    expect(() => resolveLicenseListenHost(true, "192.168.1.10")).toThrow(/FATAL \(DFP-030\)/);
    expect(resolveLicenseListenHost(false, "0.0.0.0").listenHost).toBe("0.0.0.0");
  });

  it("license-server.ts uses resolveLicenseListenHost", () => {
    const src = readFileSync(resolve(here, "../src/scripts/license-server.ts"), "utf8");
    expect(src).toMatch(/resolveLicenseListenHost/);
    expect(src).toMatch(/app\.listen\(LICENSE_SERVER_PORT, listenHost/);
  });

  it("live: loopback-only bind is reachable on 127.0.0.1 and refused on LAN IP", async () => {
    const { listenHost } = resolveLicenseListenHost(true, "0.0.0.0");
    expect(listenHost).toBe("127.0.0.1");

    const server = http.createServer((_req, res) => {
      res.statusCode = 200;
      res.end("ok");
    });
    await new Promise<void>((r) => server.listen(0, listenHost, () => r()));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("expected AddressInfo");
    const port = addr.port;

    await new Promise<void>((resolveOk, reject) => {
      const s = net.connect({ host: "127.0.0.1", port }, () => {
        s.end();
        resolveOk();
      });
      s.on("error", reject);
    });

    const lan = Object.values(os.networkInterfaces())
      .flat()
      .find((i) => i && i.family === "IPv4" && !i.internal)?.address;

    if (lan) {
      await expect(
        new Promise<void>((resolveOk, reject) => {
          const s = net.connect({ host: lan, port }, () => {
            s.end();
            resolveOk();
          });
          s.on("error", reject);
        }),
      ).rejects.toThrow();
    }

    await new Promise<void>((r) => server.close(() => r()));
  });
});
