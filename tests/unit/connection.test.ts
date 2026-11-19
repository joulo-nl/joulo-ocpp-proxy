import { describe, expect, it, beforeEach, vi } from "vitest";
import WebSocket from "ws";
import type { CsmsBackend } from "../../src/config";

import { ChargerConnection } from "../../src/connection";

interface WsConnectCall {
  url: string;
  protocols: string | string[] | undefined;
}

/** The parts of the mock socket these tests drive or inspect. */
interface MockSocket {
  readyState: number;
  /** Frames handed to send(), in order. */
  sent: string[];
  /** When true, the next send() throws, as `ws` does on a closing socket. */
  failNextSend: boolean;
  emit: (event: string, ...args: unknown[]) => void;
}

let connectCalls: WsConnectCall[] = [];
let sockets: MockSocket[] = [];

/*
 * ChargerConnection creates outbound WebSocket instances internally. Mocking
 * the module is the smallest seam that lets this unit test inspect connection
 * arguments, drive socket events, and fail a send without opening real network
 * connections.
 */
vi.mock("ws", () => {
  class MockWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    readyState = MockWebSocket.OPEN;
    sent: string[] = [];
    failNextSend = false;
    private handlers = new Map<string, ((...args: unknown[]) => void)[]>();

    constructor(url: string | null, protocols?: string | string[]) {
      if (url !== null) {
        connectCalls.push({ url, protocols });
      }
      sockets.push(this);
    }

    on(event: string, handler: (...args: unknown[]) => void) {
      const existing = this.handlers.get(event);
      if (existing) existing.push(handler);
      else this.handlers.set(event, [handler]);
      return this;
    }

    emit(event: string, ...args: unknown[]) {
      for (const handler of this.handlers.get(event) ?? []) {
        handler(...args);
      }
    }

    send(data: string) {
      if (this.failNextSend) {
        this.failNextSend = false;
        throw new Error("socket is closing");
      }
      this.sent.push(data);
      return undefined;
    }
    close() {
      this.readyState = MockWebSocket.CLOSED;
    }
    ping() {
      return undefined;
    }
    pong() {
      return undefined;
    }
  }

  return {
    default: MockWebSocket,
  };
});

beforeEach(() => {
  connectCalls = [];
  sockets = [];
});

function createMockChargerSocket() {
  // `null` is handled by the WebSocket mock above; the real `ws` constructor
  // cannot be used this way outside this test.
  return new WebSocket(null);
}

describe("ChargerConnection", () => {
  it.each([
    {
      description: "opens primary and secondary connections using resolved URLs",
      appendChargePointId: true,
      primaryUrl: "ws://csms.example/endpoint",
      secondaryUrl: "ws://secondary.example/inspect",
      protocol: "ocpp1.6",
      expectedPrimaryUrl: "ws://csms.example/endpoint/cp-abc",
      expectedSecondaryUrl: "ws://secondary.example/inspect/cp-abc",
    },
    {
      description: "keeps connection URLs unchanged when appending is disabled",
      appendChargePointId: false,
      primaryUrl: "ws://csms.example/raw-endpoint?tenant=emea",
      secondaryUrl: "ws://secondary.example/raw-mirror?source=mirror",
      protocol: "ocpp2.0.1",
      expectedPrimaryUrl: "ws://csms.example/raw-endpoint?tenant=emea",
      expectedSecondaryUrl:
        "ws://secondary.example/raw-mirror?source=mirror",
    },
  ])(
    "$description",
    ({
      appendChargePointId,
      primaryUrl,
      secondaryUrl,
      protocol,
      expectedPrimaryUrl,
      expectedSecondaryUrl,
    }) => {
      const charger = createMockChargerSocket();
      const primary: CsmsBackend = {
        url: primaryUrl,
        appendChargePointId,
      };
      const secondary: CsmsBackend = {
        url: secondaryUrl,
        appendChargePointId,
      };

      new ChargerConnection(
        charger,
        "cp-abc",
        primary,
        [secondary],
        protocol,
        undefined,
      );

      expect(connectCalls).toEqual([
        { url: expectedPrimaryUrl, protocols: [protocol] },
        { url: expectedSecondaryUrl, protocols: [protocol] },
      ]);
    }
  );

  it("queues a mirrored frame when the secondary send fails, and replays it on reconnect", () => {
    const charger = createMockChargerSocket();
    const backend: CsmsBackend = {
      url: "ws://csms.example/endpoint",
      appendChargePointId: false,
    };

    const connection = new ChargerConnection(
      charger,
      "cp-queue",
      backend,
      [backend],
      "ocpp1.6",
      undefined,
    );

    // sockets: [charger, primary, secondary]
    const [chargerSocket, primarySocket, secondarySocket] = sockets;
    const frame = '[2,"m-1","Heartbeat",{}]';

    secondarySocket.failNextSend = true;
    chargerSocket.emit("message", Buffer.from(frame));

    // The primary still got it, and the failed mirror wasn't dropped...
    expect(primarySocket.sent).toEqual([frame]);
    expect(secondarySocket.sent).toEqual([]);

    // ...it was queued, and goes out when the secondary comes back.
    secondarySocket.emit("open");
    expect(secondarySocket.sent).toEqual([frame]);

    connection.teardown();
  });
});
