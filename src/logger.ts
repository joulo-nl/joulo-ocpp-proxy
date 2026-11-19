import {
  OCPP_MSG_CALL,
  OCPP_MSG_CALLERROR,
  OCPP_MSG_CALLRESULT,
  type ParsedMessage,
} from "./types";
import { parseOcppFrameArray } from "./utils/ocpp";

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export const DEFAULT_LOG_LEVEL: LogLevel = "info";
export const DEFAULT_DEBUG_MESSAGE_MAX_LENGTH = 120;

export interface LoggerConfig {
  logLevel: LogLevel;
  debugMessageMaxLength?: number;
  sink?: LoggerSink;
}

export interface LoggerSink {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

const defaultLoggerSink: LoggerSink = {
  stdout: (line) => {
    process.stdout.write(line + "\n");
  },
  stderr: (line) => {
    process.stderr.write(line + "\n");
  },
};

let loggerSink: LoggerSink = defaultLoggerSink;

export function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

export function parseLogLevel(
  value: string | undefined,
  fallback: LogLevel = DEFAULT_LOG_LEVEL
): LogLevel {
  const level = (value ?? fallback).toLowerCase();
  return isLogLevel(level) ? level : fallback;
}

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let minLevel: LogLevel = DEFAULT_LOG_LEVEL;
let debugMessageMaxLength: number | undefined = DEFAULT_DEBUG_MESSAGE_MAX_LENGTH;

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

export function setDebugMessageMaxLength(value?: number): void {
  debugMessageMaxLength = value;
}

function resolveDebugMessageMaxLength(
  config: Partial<LoggerConfig>
): number | undefined {
  if ("debugMessageMaxLength" in config) {
    return config.debugMessageMaxLength;
  }

  return DEFAULT_DEBUG_MESSAGE_MAX_LENGTH;
}

function setLoggerSink(sink: LoggerSink): void {
  loggerSink = sink;
}

export function configureLogger(config: Partial<LoggerConfig> = {}): void {
  const { logLevel, sink } = config;
  setLogLevel(logLevel ?? DEFAULT_LOG_LEVEL);
  setDebugMessageMaxLength(resolveDebugMessageMaxLength(config));
  setLoggerSink(sink ?? defaultLoggerSink);
}

function truncateMessage(raw: string): string {
  if (debugMessageMaxLength === undefined) return raw;
  return raw.slice(0, debugMessageMaxLength);
}

function formatOcppFrame(type: unknown, id: string, raw: string): string {
  const payload = truncateMessage(raw);

  if (type === OCPP_MSG_CALL) {
    return `[OCPP CALL] (${id}): ${payload}`;
  }

  if (type === OCPP_MSG_CALLRESULT) {
    return `[OCPP RESULT] (${id}): ${payload}`;
  }

  if (type === OCPP_MSG_CALLERROR) {
    return `[OCPP ERROR] (${id}): ${payload}`;
  }

  return `[OCPP UNKNOWN] (${String(type)}): ${payload}`;
}

/**
 * Summarize a frame for debug output. Callers that already decoded the frame
 * pass the parsed message so it isn't parsed a second time here.
 *
 * The elements are formatted without validating them, so an unrecognized
 * message type is still labelled rather than dumped as raw text.
 */
function summarizeOcppFrame(frame: string | ParsedMessage): string {
  if (typeof frame !== "string") {
    return formatOcppFrame(frame.type, frame.id, frame.raw);
  }

  const elements = parseOcppFrameArray(frame);
  if (elements === null) return truncateMessage(frame);

  return formatOcppFrame(elements[0], String(elements[1]), frame);
}

function buildOcppFrameDebugExtra(
  payload: string | ParsedMessage,
  extra?: object
): object | undefined {
  if (!extra) return { message: summarizeOcppFrame(payload) };

  const fields = extra as Record<string, unknown>;
  return {
    ...fields,
    message: summarizeOcppFrame(payload),
  };
}

function log(level: LogLevel, tag: string, message: string, extra?: object) {
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[minLevel]) return;

  const entry: Record<string, unknown> = {
    time: new Date().toISOString(),
    level,
    tag,
    msg: message,
    ...extra,
  };

  const line = JSON.stringify(entry);

  if (level === "error") loggerSink.stderr(line);
  else loggerSink.stdout(line);
}

export function createLogger(tag: string) {
  return {
    debug: (msg: string, extra?: object) => {
      log("debug", tag, msg, extra);
    },
    debugOcppFrame: (
      msg: string,
      payload: string | ParsedMessage,
      extra?: object
    ) => {
      log("debug", tag, msg, buildOcppFrameDebugExtra(payload, extra));
    },
    info: (msg: string, extra?: object) => {
      log("info", tag, msg, extra);
    },
    warn: (msg: string, extra?: object) => {
      log("warn", tag, msg, extra);
    },
    error: (msg: string, extra?: object) => {
      log("error", tag, msg, extra);
    },
  };
}
