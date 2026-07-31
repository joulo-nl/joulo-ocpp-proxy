import {
  OCPP_MSG_CALL,
  OCPP_MSG_CALLERROR,
  OCPP_MSG_CALLRESULT,
  type OcppMessageType,
  type ParsedMessage,
} from "../types";

const MESSAGE_TYPES: readonly OcppMessageType[] = [
  OCPP_MSG_CALL,
  OCPP_MSG_CALLRESULT,
  OCPP_MSG_CALLERROR,
];

const DECIMAL_INTEGER = /^\d+$/;

/**
 * OCPP-J sends the message type id as a number, but some implementations send a
 * decimal string. Accept both and nothing else: bare Number() would also take
 * "0x2", "2.0" and " 2 ", and a routing decision shouldn't rest on those.
 */
function toOcppMessageType(value: unknown): OcppMessageType | null {
  let numeric: number;
  if (typeof value === "number") {
    numeric = value;
  } else if (typeof value === "string" && DECIMAL_INTEGER.test(value)) {
    numeric = Number(value);
  } else {
    return null;
  }

  return MESSAGE_TYPES.find((messageType) => messageType === numeric) ?? null;
}

/**
 * The element array of an OCPP-J frame, or null when the text isn't one.
 *
 * Shared by the two views of a frame: decodeOcppFrame() validates the elements
 * because routing depends on them, while the logger formats them as-is so it
 * can still label a message type this proxy doesn't recognize.
 */
export function parseOcppFrameArray(raw: string): unknown[] | null {
  let frame: unknown;
  try {
    frame = JSON.parse(raw);
  } catch {
    return null;
  }

  return Array.isArray(frame) && frame.length >= 3 ? frame : null;
}

/**
 * Parse a raw WebSocket frame into a structured OCPP message, or return null
 * when the frame is not valid OCPP JSON. Callers decode a frame once and reuse
 * the result for both routing and logging.
 */
export function decodeOcppFrame(raw: string): ParsedMessage | null {
  const frame = parseOcppFrameArray(raw);
  if (frame === null) return null;

  const [rawType, rawId, third] = frame;
  const type = toOcppMessageType(rawType);
  if (type === null) return null;
  if (typeof rawId !== "string" && typeof rawId !== "number") return null;

  const id = String(rawId);

  if (type === OCPP_MSG_CALL) {
    if (typeof third !== "string") return null;
    return { type, id, raw, action: third };
  }

  return { type, id, raw };
}
