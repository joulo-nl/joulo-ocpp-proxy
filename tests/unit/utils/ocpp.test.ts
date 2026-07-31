import { describe, expect, it } from "vitest";

import {
  OCPP_MSG_CALL,
  OCPP_MSG_CALLERROR,
  OCPP_MSG_CALLRESULT,
} from "../../../src/types";
import { decodeOcppFrame } from "../../../src/utils/ocpp";

describe("decodeOcppFrame", () => {
  it("decodes a CALL frame", () => {
    const raw = '[2,"msg-1","BootNotification",{"model":"X"}]';

    expect(decodeOcppFrame(raw)).toEqual({
      type: OCPP_MSG_CALL,
      id: "msg-1",
      action: "BootNotification",
      raw,
    });
  });

  it("decodes a CALLRESULT frame", () => {
    const raw = '[3,"msg-1",{"status":"Accepted"}]';

    expect(decodeOcppFrame(raw)).toEqual({
      type: OCPP_MSG_CALLRESULT,
      id: "msg-1",
      raw,
    });
  });

  it("decodes a CALLERROR frame", () => {
    const raw = '[4,"msg-1","NotSupported","unknown action",{}]';

    expect(decodeOcppFrame(raw)).toEqual({
      type: OCPP_MSG_CALLERROR,
      id: "msg-1",
      raw,
    });
  });

  it("accepts a message type id sent as a decimal string", () => {
    expect(decodeOcppFrame('["2","msg-1","Heartbeat",{}]')?.type).toBe(
      OCPP_MSG_CALL
    );
  });

  it.each([
    { description: "hexadecimal", value: '"0x2"' },
    { description: "a decimal fraction", value: '"2.0"' },
    { description: "exponential", value: '"2e0"' },
    { description: "padded with spaces", value: '" 2 "' },
  ])("rejects a message type id written as $description", ({ value }) => {
    expect(decodeOcppFrame(`[${value},"msg-1","Heartbeat",{}]`)).toBeNull();
  });

  it.each([
    { description: "invalid JSON", raw: "{ not json" },
    { description: "not an array", raw: '{"type":2}' },
    { description: "too short", raw: '[2,"msg-1"]' },
    { description: "unknown message type", raw: '[9,"msg-1","Heartbeat",{}]' },
    { description: "a CALL without an action", raw: '[2,"msg-1",{},{}]' },
  ])("returns null for $description", ({ raw }) => {
    expect(decodeOcppFrame(raw)).toBeNull();
  });
});
