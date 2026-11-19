import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "http";

import { startProxy } from "../../src/proxy";
import { rawDataToString } from "../../src/utils/websocket";

interface WsRecord {
  httpServer: ReturnType<typeof createServer>;
  server: WebSocketServer;
  connections: WebSocket[];
}

interface UrlAwareConnection {
  socket: WebSocket;
  url: string;
}

function waitForOpen(socket: WebSocket, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("websocket timeout"));
    }, timeoutMs);
    socket.once("open", () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

function waitForClose(
  socket: WebSocket,
  timeoutMs = 2000
): Promise<{ code: number; reason: Buffer }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("websocket close timeout"));
    }, timeoutMs);
    const onError = (error: Error) => {
      clearTimeout(timeout);
      socket.off("close", onClose);
      reject(error);
    };
    const onClose = (code: number, reason: Buffer) => {
      clearTimeout(timeout);
      socket.off("error", onError);
      resolve({ code, reason: Buffer.from(reason) });
    };
    socket.once("close", onClose);
    socket.once("error", onError);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function connectWhenOpen(
  url: string,
  protocol: string,
  timeoutMs = 3000,
  retryMs = 25
): Promise<WebSocket> {
  const deadline = Date.now() + timeoutMs;
  let lastError: Error | null = null;

  while (Date.now() < deadline) {
    const socket = new WebSocket(url, protocol);
    try {
      await waitForOpen(socket, retryMs);
      return socket;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (lastError.message.includes("ECONNREFUSED") || lastError.message.includes("connect")) {
        await sleep(retryMs);
        continue;
      }
      throw lastError;
    }
  }

  throw lastError ?? new Error("websocket failed to open");
}

function waitForMessage(socket: WebSocket, timeoutMs = 2000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("websocket message timeout"));
    }, timeoutMs);
    socket.once("message", (data) => {
      clearTimeout(timeout);
      resolve(rawDataToString(data));
    });
  });
}

function createWsServer(): WsRecord {
  const httpServer = createServer();
  const server = new WebSocketServer({ server: httpServer });
  return { httpServer, server, connections: [] };
}

function startWsServer(record: WsRecord): Promise<number> {
  const { httpServer } = record;
  return new Promise((resolve, reject) => {
    const existingAddress = httpServer.address();
    if (httpServer.listening && existingAddress && typeof existingAddress === "object") {
      resolve(existingAddress.port);
      return;
    }

    httpServer.once("error", (error) => {
      reject(error);
    });

    httpServer.once("listening", () => {
      const address = httpServer.address();
      if (address && typeof address === "object") {
        resolve(address.port);
        return;
      }
      reject(new Error("websocket server started without address"));
    });

    httpServer.listen(0, "127.0.0.1");
  });
}

function waitForConnection(record: WsRecord): Promise<UrlAwareConnection> {
  return new Promise((resolve) => {
    record.server.once("connection", (socket: WebSocket, request) => {
      record.connections.push(socket);
      resolve({
        socket,
        url: request.url ?? "",
      });
    });
  });
}

async function closeAll(records: WsRecord[]) {
  for (const record of records) {
    for (const socket of record.connections) {
      if (socket.readyState <= WebSocket.OPEN) socket.close();
    }
    await new Promise<void>((resolve) => {
      record.server.close(() => {
        record.httpServer.close(() => {
          resolve();
        });
      });
    });
  }
}

describe("proxy feature", () => {
  let primary: WsRecord;
  let secondary: WsRecord;
  let openChargers: WebSocket[] = [];

  const allocatePort = (): Promise<number> =>
    new Promise((resolve, reject) => {
      const s = createServer();
      s.once("error", reject);
      s.listen(0, "127.0.0.1", () => {
        const address = s.address();
        if (!address || typeof address !== "object") {
          reject(new Error("Failed to allocate port"));
          return;
        }

        const port = address.port;
        s.close(() => {
          resolve(port);
        });
      });
    });

  beforeEach(() => {
    primary = createWsServer();
    secondary = createWsServer();
    openChargers = [];
  });

  afterEach(async () => {
      for (const charger of openChargers) {
          if (charger.readyState <= WebSocket.OPEN) {
              charger.close();
          }
      }

      await closeAll([primary, secondary]);
  });

  it("forwards charger frames to primary and secondary, and forwards primary response back", async () => {
    const bootFrame = '["2","msg-1","BootNotification",{}]';
    const responseFrame = '["3","msg-1",{}]';

    const primaryConnPromise = waitForConnection(primary);
    const secondaryConnPromise = waitForConnection(secondary);

    const primaryPort = await startWsServer(primary);
    const secondaryPort = await startWsServer(secondary);
    const proxyPort = await allocatePort();

    startProxy(
      {
        port: proxyPort,
        primaryCsms: {
          url: `ws://127.0.0.1:${String(primaryPort)}`,
          appendChargePointId: true,
        },
        secondaryCsms: [
          {
            url: `ws://127.0.0.1:${String(secondaryPort)}`,
            appendChargePointId: true,
          }
        ],
        loggerConfig: {
          logLevel: "error",
        },
      }
    );

    const charger = await connectWhenOpen(
      `ws://127.0.0.1:${String(proxyPort)}/charger-1`,
      "ocpp1.6"
    );
    openChargers.push(charger);

    const [{ socket: primaryConn }, { socket: secondaryConn }] =
      await Promise.all([
        primaryConnPromise,
        secondaryConnPromise,
      ]);

    const primaryMessage = waitForMessage(primaryConn, 5000);
    const secondaryMessage = waitForMessage(secondaryConn);
    charger.send(bootFrame);

    expect(await primaryMessage).toBe(bootFrame);
    expect(await secondaryMessage).toBe(bootFrame);

    const chargerMessage = waitForMessage(charger);
    primaryConn.send(responseFrame);
    expect(await chargerMessage).toBe(responseFrame);
  });

  it("mirrors charger frames to secondaries except its responses", async () => {
    const callFrame = '[2,"msg-1","Heartbeat",{}]';
    const resultFrame = '[3,"msg-2",{}]';
    const garbageFrame = "not-ocpp";

    const primaryConnPromise = waitForConnection(primary);
    const secondaryConnPromise = waitForConnection(secondary);

    const primaryPort = await startWsServer(primary);
    const secondaryPort = await startWsServer(secondary);
    const proxyPort = await allocatePort();

    startProxy({
      port: proxyPort,
      primaryCsms: {
        url: `ws://127.0.0.1:${String(primaryPort)}`,
        appendChargePointId: true,
      },
      secondaryCsms: [
        {
          url: `ws://127.0.0.1:${String(secondaryPort)}`,
          appendChargePointId: true,
        },
      ],
      loggerConfig: {
        logLevel: "error",
      },
    });

    const charger = await connectWhenOpen(
      `ws://127.0.0.1:${String(proxyPort)}/charger-1`,
      "ocpp1.6"
    );
    openChargers.push(charger);

    const [{ socket: primaryConn }, { socket: secondaryConn }] =
      await Promise.all([primaryConnPromise, secondaryConnPromise]);

    const primaryFrames: string[] = [];
    primaryConn.on("message", (data) => {
      primaryFrames.push(rawDataToString(data));
    });
    const secondaryFrames: string[] = [];
    secondaryConn.on("message", (data) => {
      secondaryFrames.push(rawDataToString(data));
    });

    charger.send(resultFrame);
    charger.send(garbageFrame);
    charger.send(callFrame);
    await sleep(250);

    // The primary sees everything. The secondary sees everything the charger
    // initiated — including the frame the proxy couldn't parse, so an
    // unrecognized message type is never silently dropped from the mirror —
    // but not the response, which answers a request only the primary made.
    expect(primaryFrames).toEqual([resultFrame, garbageFrame, callFrame]);
    expect(secondaryFrames).toEqual([garbageFrame, callFrame]);
  });

  it("accepts charger URLs with query parameters", async () => {
    const primaryConnPromise = waitForConnection(primary);

    const primaryPort = await startWsServer(primary);
    const proxyPort = await allocatePort();

    startProxy(
      {
        port: proxyPort,
        primaryCsms: {
          url: `ws://127.0.0.1:${String(primaryPort)}`,
          appendChargePointId: true,
        },
        secondaryCsms: [],
        loggerConfig: {
          logLevel: "error",
          debugMessageMaxLength: 120,
        },
      }
    );

    const charger = await connectWhenOpen(
      `ws://127.0.0.1:${String(proxyPort)}/ocpp/cp-query?foo=bar`,
      "ocpp1.6"
    );
    openChargers.push(charger);

    const { socket: primaryConn, url: upstreamPath } = await primaryConnPromise;

    expect(upstreamPath).toBe("/cp-query");
    expect(primaryConn.readyState).toBe(WebSocket.OPEN);
    expect(charger.readyState).toBe(WebSocket.OPEN);
  });

  it("keeps charge point ID in resolved primary URL when primary has query params", async () => {
    const primaryConnPromise = waitForConnection(primary);

    const primaryPort = await startWsServer(primary);
    const proxyPort = await allocatePort();

    startProxy(
      {
        port: proxyPort,
        primaryCsms: {
          url: `ws://127.0.0.1:${String(primaryPort)}/endpoint?tenant=emea`,
          appendChargePointId: true,
        },
        secondaryCsms: [],
        loggerConfig: {
          logLevel: "error",
          debugMessageMaxLength: 120,
        },
      }
    );

    const charger = await connectWhenOpen(
      `ws://127.0.0.1:${String(proxyPort)}/cp-query?a=b&c=d`,
      "ocpp1.6"
    );
    openChargers.push(charger);

    const { socket: primaryConn, url: upstreamUrl } = await primaryConnPromise;
    expect(upstreamUrl).toBe("/endpoint/cp-query?tenant=emea");
    expect(primaryConn.readyState).toBe(WebSocket.OPEN);
    expect(charger.readyState).toBe(WebSocket.OPEN);
  });

  it("keeps charge point ID in resolved secondary URL when secondary has query params", async () => {
    const primaryConnPromise = waitForConnection(primary);
    const secondaryConnPromise = waitForConnection(secondary);

    const primaryPort = await startWsServer(primary);
    const secondaryPort = await startWsServer(secondary);
    const proxyPort = await allocatePort();

    startProxy(
      {
        port: proxyPort,
        primaryCsms: {
          url: `ws://127.0.0.1:${String(primaryPort)}`,
          appendChargePointId: true,
        },
        secondaryCsms: [{
          url: `ws://127.0.0.1:${String(secondaryPort)}/mirror?tenant=auditor`,
          appendChargePointId: true,
        }],
        loggerConfig: {
          logLevel: "error",
          debugMessageMaxLength: 120,
        },
      }
    );

    const charger = await connectWhenOpen(
      `ws://127.0.0.1:${String(proxyPort)}/cp-secondary?foo=bar`,
      "ocpp1.6"
    );
    openChargers.push(charger);

    const [{ socket: primaryConn }, secondaryConn] = await Promise.all([
      primaryConnPromise,
      secondaryConnPromise,
    ]);

    expect(secondaryConn.url).toBe("/mirror/cp-secondary?tenant=auditor");
    expect(primaryConn.readyState).toBe(WebSocket.OPEN);
    expect(secondaryConn.socket.readyState).toBe(WebSocket.OPEN);
    expect(charger.readyState).toBe(WebSocket.OPEN);
  });

  it("rejects charger connections without a charge point ID", async () => {
    const primaryPort = await startWsServer(primary);
    const proxyPort = await allocatePort();

    startProxy(
      {
        port: proxyPort,
        primaryCsms: {
          url: `ws://127.0.0.1:${String(primaryPort)}`,
          appendChargePointId: true,
        },
        secondaryCsms: [],
        loggerConfig: {
          logLevel: "error",
        },
      }
    );

    const charger = await connectWhenOpen(`ws://127.0.0.1:${String(proxyPort)}/`, "ocpp1.6");
    openChargers.push(charger);
    const closeEvent = await waitForClose(charger);

    expect(closeEvent.code).toBe(1002);
    expect(primary.connections).toHaveLength(0);
  });

  it("drops charger connection when primary is unavailable", async () => {
    const proxyPort = await allocatePort();

    startProxy(
      {
        port: proxyPort,
        primaryCsms: {
          url: `ws://127.0.0.1:9`,
          appendChargePointId: true,
        },
        secondaryCsms: [],
        loggerConfig: {
          logLevel: "error",
        },
      }
    );

    const charger = await connectWhenOpen(
      `ws://127.0.0.1:${String(proxyPort)}/cp-offline`,
      "ocpp1.6"
    );
    openChargers.push(charger);

    const closed = await Promise.race<{
      closed: true;
      code: number;
      reason: Buffer;
    } | { closed: false }>([
      (async () => {
        const event = await waitForClose(charger);
        return { closed: true, code: event.code, reason: event.reason };
      })(),
      sleep(250).then(() => ({ closed: false })),
    ]);

    expect(closed.closed).toBe(true);
    if (!closed.closed) {
      throw new Error("charger connection did not close");
    }
    expect(closed.code).toBeTypeOf("number");
    expect(Buffer.isBuffer(closed.reason)).toBe(true);
  });

  it("replaces existing session for same charge point", async () => {
    const firstPrimaryConn = waitForConnection(primary);

    const primaryPort = await startWsServer(primary);
    const proxyPort = await allocatePort();

    startProxy(
      {
        port: proxyPort,
        primaryCsms: {
          url: `ws://127.0.0.1:${String(primaryPort)}`,
          appendChargePointId: true,
        },
        secondaryCsms: [],
        loggerConfig: {
          logLevel: "error",
        },
      }
    );

    const firstCharger = await connectWhenOpen(
      `ws://127.0.0.1:${String(proxyPort)}/cp-reconnect`,
      "ocpp1.6"
    );
    openChargers.push(firstCharger);

    const { socket: firstUpstream } = await firstPrimaryConn;
    const firstClose = waitForClose(firstUpstream);

    const secondPrimaryConn = waitForConnection(primary);

    const secondCharger = await connectWhenOpen(
      `ws://127.0.0.1:${String(proxyPort)}/cp-reconnect`,
      "ocpp1.6"
    );
    openChargers.push(secondCharger);

    const { socket: secondUpstream } = await secondPrimaryConn;

    const firstCloseEvent = await firstClose;

    expect(firstCloseEvent.code).toBe(1000);
    expect(secondUpstream.readyState).toBe(WebSocket.OPEN);

    const closeWaits: Promise<{ code: number; reason: Buffer }>[] = [];
    if (firstCharger.readyState <= WebSocket.OPEN) {
      closeWaits.push(waitForClose(firstCharger));
      firstCharger.close();
    }
    if (secondCharger.readyState <= WebSocket.OPEN) {
      closeWaits.push(waitForClose(secondCharger));
      secondCharger.close();
    }

    closeWaits.push(waitForClose(secondUpstream));
    await Promise.all(closeWaits);
  });
});
