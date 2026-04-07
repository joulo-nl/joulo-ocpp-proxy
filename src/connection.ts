import WebSocket from "ws";
import { createLogger } from "./logger";
import { OCPP_MSG_CALL, OCPP_SUBPROTOCOLS, type ParsedMessage } from "./types";

/**
 * Manages the full lifecycle of a single charger connection:
 *
 *   Charger  ←─→  Proxy  ←─→  Primary CSMS
 *                         ──→  Secondary CSMS (mirror, one-way)
 *
 * - Messages from the charger are forwarded to the primary and mirrored
 *   to all secondaries.
 * - Only the primary CSMS can send commands back to the charger.
 * - Secondary connections are best-effort; failures never affect the
 *   charger or the primary link.
 */
export class ChargerConnection {
  private readonly log;
  private primary: WebSocket | null = null;
  private secondaries: WebSocket[] = [];
  private alive = true;

  constructor(
    private readonly charger: WebSocket,
    private readonly chargePointId: string,
    private readonly primaryUrl: string,
    private readonly secondaryUrls: string[],
    private readonly protocol: string,
    private readonly authHeader: string | undefined
  ) {
    this.log = createLogger(chargePointId);
    this.setup();
  }

  private setup() {
    this.primary = this.connectUpstream(this.primaryUrl, true);

    for (const url of this.secondaryUrls) {
      this.secondaries.push(this.connectUpstream(url, false));
    }

    this.charger.on("message", (data) => {
      const raw = data.toString();
      this.log.debug("charger → proxy", { message: this.summarise(raw) });

      if (this.primary?.readyState === WebSocket.OPEN) {
        this.primary.send(raw);
      }

      for (const sec of this.secondaries) {
        if (sec.readyState === WebSocket.OPEN) {
          try {
            sec.send(raw);
          } catch {
            /* best-effort */
          }
        }
      }
    });

    this.charger.on("close", (code, reason) => {
      this.log.info("charger disconnected", {
        code,
        reason: reason.toString(),
      });
      this.teardown();
    });

    this.charger.on("error", (err) => {
      this.log.error("charger connection error", { error: err.message });
    });

    this.charger.on("ping", (data) => {
      this.primary?.ping(data);
    });

    this.charger.on("pong", (data) => {
      this.primary?.pong(data);
    });

    this.log.info("session started", {
      primary: this.primaryUrl,
      secondaries: this.secondaryUrls,
      protocol: this.protocol,
    });
  }

  /** Connect to an upstream CSMS. If `isPrimary`, its responses go to the charger. */
  private connectUpstream(baseUrl: string, isPrimary: boolean): WebSocket {
    const url = `${baseUrl.replace(/\/+$/, "")}/${this.chargePointId}`;
    const label = isPrimary ? "primary" : "secondary";

    const headers: Record<string, string> = {};
    if (this.authHeader) {
      headers["Authorization"] = this.authHeader;
    }

    const ws = new WebSocket(url, this.protocol ? [this.protocol] : OCPP_SUBPROTOCOLS, {
      headers,
      handshakeTimeout: 10_000,
    });

    ws.on("open", () => {
      this.log.info(`${label} connected`, { url });
    });

    ws.on("message", (data) => {
      const raw = data.toString();

      if (isPrimary) {
        this.log.debug(`${label} → charger`, {
          message: this.summarise(raw),
        });
        if (this.charger.readyState === WebSocket.OPEN) {
          this.charger.send(raw);
        }
      } else {
        this.log.debug(`${label} response (ignored)`, {
          url,
          message: this.summarise(raw),
        });
      }
    });

    ws.on("close", (code, reason) => {
      this.log.warn(`${label} disconnected`, {
        url,
        code,
        reason: reason.toString(),
      });
      if (isPrimary) {
        this.charger.close(1001, "Primary CSMS disconnected");
        this.teardown();
      }
    });

    ws.on("error", (err) => {
      this.log.error(`${label} error`, { url, error: err.message });
      if (isPrimary && this.alive) {
        this.charger.close(1011, "Primary CSMS unreachable");
        this.teardown();
      }
    });

    ws.on("ping", (data) => {
      if (isPrimary) this.charger.ping(data);
    });

    ws.on("pong", (data) => {
      if (isPrimary) this.charger.pong(data);
    });

    return ws;
  }

  private teardown() {
    if (!this.alive) return;
    this.alive = false;

    const close = (ws: WebSocket | null) => {
      if (ws && ws.readyState <= WebSocket.OPEN) {
        ws.close(1000);
      }
    };

    close(this.primary);
    this.secondaries.forEach(close);
    close(this.charger);

    this.log.info("session ended");
  }

  /** Return a short summary string for logging (avoids dumping huge payloads). */
  private summarise(raw: string): string {
    try {
      const msg = JSON.parse(raw) as unknown[];
      if (!Array.isArray(msg) || msg.length < 3) return raw.slice(0, 120);

      const type = msg[0] as number;
      const id = msg[1] as string;

      if (type === OCPP_MSG_CALL) {
        return `[CALL] ${msg[2]} (${id})`;
      }
      return `[${type === 3 ? "RESULT" : "ERROR"}] (${id})`;
    } catch {
      return raw.slice(0, 120);
    }
  }
}
