import {
  describe,
  expect,
  it,
  beforeEach,
} from "vitest";

import { configureLogger, createLogger } from "../../src/logger";
import { OCPP_MSG_CALLRESULT } from "../../src/types";

function parseLogEntry(line: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(line);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Expected a JSON log object");
  }
  return parsed as Record<string, unknown>;
}

describe("logger", () => {
  const createSink = () => {
    const stdoutEntries: string[] = [];
    const stderrEntries: string[] = [];

    return {
      sink: {
        stdout: (line: string) => stdoutEntries.push(line),
        stderr: (line: string) => stderrEntries.push(line),
      },
      stdoutEntries,
      stderrEntries,
    };
  };

  beforeEach(() => {
    configureLogger({ logLevel: "info" });
  });

  it("suppresses logs below configured level", () => {
    const { sink, stdoutEntries, stderrEntries } = createSink();
    configureLogger({ logLevel: "error", sink });
    const logger = createLogger("proxy");

    logger.info("info message");
    logger.error("error message");

    expect(stdoutEntries).toHaveLength(0);
    expect(stderrEntries).toHaveLength(1);
    expect(parseLogEntry(stderrEntries[0]).level).toBe("error");
  });

  const longPayload =
    '[2,"abc","Heartbeat",{"data":"' + "a".repeat(160) + '"}]';

  it.each([
    {
      description: "uses a configured limit",
      config: { debugMessageMaxLength: 4 },
      payload: '[2,"abc","Heartbeat",{}]',
      expectedPayload: '[2,"',
    },
    {
      description: "uses the default limit",
      config: {},
      payload: longPayload,
      expectedPayload: longPayload.slice(0, 120),
    },
    {
      description: "does not truncate when the limit is explicitly undefined",
      config: { debugMessageMaxLength: undefined },
      payload: longPayload,
      expectedPayload: longPayload,
    },
  ])(
      "$description",
      ({ config, payload, expectedPayload }) => {
        const { sink, stdoutEntries } = createSink();
        configureLogger({ logLevel: "debug", sink, ...config });
        const logger = createLogger("proxy");

        logger.debugOcppFrame("charger -> proxy", payload);

        const parsed = parseLogEntry(stdoutEntries[0]);
        expect(parsed.level).toBe("debug");
        expect(parsed.message).toBe(
            "[OCPP CALL] (abc): " + expectedPayload
        );
      }
  );

  it("formats an already-decoded frame without reparsing it", () => {
    const { sink, stdoutEntries } = createSink();
    configureLogger({ logLevel: "debug", sink });
    const logger = createLogger("proxy");

    // `raw` is deliberately not valid JSON: the label can only come out right
    // if the logger trusts the decoded fields instead of parsing again.
    logger.debugOcppFrame("charger -> proxy", {
      type: OCPP_MSG_CALLRESULT,
      id: "xyz",
      raw: "<<already decoded>>",
    });

    expect(parseLogEntry(stdoutEntries[0]).message).toBe(
      "[OCPP RESULT] (xyz): <<already decoded>>"
    );
  });

  it("truncates a decoded frame with the configured limit", () => {
    const { sink, stdoutEntries } = createSink();
    configureLogger({ logLevel: "debug", sink, debugMessageMaxLength: 8 });
    const logger = createLogger("proxy");

    logger.debugOcppFrame("charger -> proxy", {
      type: OCPP_MSG_CALLRESULT,
      id: "xyz",
      raw: '[3,"xyz",{"status":"Accepted"}]',
    });

    expect(parseLogEntry(stdoutEntries[0]).message).toBe(
      "[OCPP RESULT] (xyz): [3,\"xyz\""
    );
  });

  it("labels a frame whose message type it does not recognize", () => {
    const { sink, stdoutEntries } = createSink();
    configureLogger({ logLevel: "debug", sink });
    const logger = createLogger("proxy");

    logger.debugOcppFrame("charger -> proxy", '[9,"abc","Whatever",{}]');

    expect(parseLogEntry(stdoutEntries[0]).message).toBe(
      '[OCPP UNKNOWN] (9): [9,"abc","Whatever",{}]'
    );
  });

  it("writes logs to a provided sink", () => {
    const outputSink = createSink();
    configureLogger({
      logLevel: "debug",
      sink: outputSink.sink,
    });
    const logger = createLogger("proxy");

    logger.debug("debug message");
    logger.info("info message");
    logger.warn("warn message");
    logger.error("error message");

    expect(outputSink.stdoutEntries).toHaveLength(3);
    expect(outputSink.stderrEntries).toHaveLength(1);
    expect(parseLogEntry(outputSink.stderrEntries[0]).level).toBe("error");
  });
});
