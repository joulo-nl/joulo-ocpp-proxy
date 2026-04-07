import { createServer, type IncomingMessage } from "http";
import { WebSocketServer, WebSocket } from "ws";
import type { Config } from "./config";
import { ChargerConnection } from "./connection";
import { createLogger } from "./logger";
import { OCPP_SUBPROTOCOLS } from "./types";

const log = createLogger("proxy");

/**
 * Start the OCPP proxy server.
 *
 * Chargers connect via:
 *   ws(s)://proxy-host:port/<chargePointId>
 *
 * The proxy appends the same chargePointId to each upstream CSMS URL.
 */
export function startProxy(config: Config) {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(
      "joulo-ocpp-proxy is running.\n" +
        "Connect your charge point via WebSocket.\n"
    );
  });

  const wss = new WebSocketServer({
    server,
    handleProtocols: (protocols) => {
      for (const p of OCPP_SUBPROTOCOLS) {
        if (protocols.has(p)) return p;
      }
      return false;
    },
  });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const chargePointId = extractChargePointId(req.url);
    if (!chargePointId) {
      log.warn("rejected connection: no charge point ID in path", {
        url: req.url,
      });
      ws.close(1002, "Charge point ID required in URL path");
      return;
    }

    const protocol = ws.protocol;
    const authHeader = req.headers["authorization"] as string | undefined;

    log.info("charger connected", {
      chargePointId,
      protocol: protocol || "none",
      ip: req.socket.remoteAddress,
    });

    new ChargerConnection(
      ws,
      chargePointId,
      config.primaryUrl,
      config.secondaryUrls,
      protocol,
      authHeader
    );
  });

  wss.on("error", (err) => {
    log.error("WebSocket server error", { error: err.message });
  });

  server.listen(config.port, () => {
    log.info("proxy listening", {
      port: config.port,
      primary: config.primaryUrl,
      secondaries: config.secondaryUrls,
    });
  });

  const shutdown = () => {
    log.info("shutting down…");
    wss.clients.forEach((ws) => ws.close(1001, "Server shutting down"));
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function extractChargePointId(url: string | undefined): string | null {
  if (!url) return null;
  const segments = url
    .split("?")[0]
    .split("/")
    .filter(Boolean);
  // Accept /ocpp/<id>, /ws/<id>, or just /<id>
  if (segments.length === 0) return null;
  return segments[segments.length - 1];
}
