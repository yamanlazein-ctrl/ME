/**
 * DFP-030 — live proof that openLoopback-style binds are loopback-only:
 * a server listening on 127.0.0.1 rejects connections via the machine's
 * non-loopback address (same contract as license-server listenHost).
 */
import { describe, it, expect } from "vitest";
import http from "node:http";
import os from "node:os";
import net from "node:net";

function lanIpv4(): string | null {
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family === "IPv4" && !info.internal) return info.address;
    }
  }
  return null;
}

function listen(host: string): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((_req, res) => {
    res.statusCode = 200;
    res.end("ok");
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("expected TCP address"));
        return;
      }
      resolve({ server, port: addr.port });
    });
  });
}

function tryConnect(host: string, port: number, ms = 1500): Promise<"ok" | "refused"> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve("refused");
    }, ms);
    socket.on("connect", () => {
      clearTimeout(timer);
      socket.end();
      resolve("ok");
    });
    socket.on("error", () => {
      clearTimeout(timer);
      resolve("refused");
    });
  });
}

describe("DFP-030 live loopback bind", () => {
  it("127.0.0.1 listen accepts loopback and refuses LAN IP", async () => {
    const { server, port } = await listen("127.0.0.1");
    try {
      expect(await tryConnect("127.0.0.1", port)).toBe("ok");
      const lan = lanIpv4();
      if (lan) {
        expect(await tryConnect(lan, port)).toBe("refused");
      }
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
