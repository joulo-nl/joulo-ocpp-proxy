/**
 * OCPP WebSocket message types (applies to both 1.6 and 2.0.1).
 *
 * Every OCPP message is a JSON array:
 *   [messageTypeId, uniqueId, ...]
 *
 * - CALL (2):       [2, "<id>", "<action>", {payload}]
 * - CALLRESULT (3): [3, "<id>", {payload}]
 * - CALLERROR (4):  [4, "<id>", "<errorCode>", "<description>", {details}]
 */
export const OCPP_MSG_CALL = 2;
export const OCPP_MSG_CALLRESULT = 3;
export const OCPP_MSG_CALLERROR = 4;

export type OcppMessageType =
  | typeof OCPP_MSG_CALL
  | typeof OCPP_MSG_CALLRESULT
  | typeof OCPP_MSG_CALLERROR;

export interface ParsedMessage {
  type: OcppMessageType;
  id: string;
  raw: string;
  action?: string;
}

/**
 * OCPP WebSocket sub-protocols in preference order.
 * The proxy negotiates whichever the charger and CSMS both support.
 */
export const OCPP_SUBPROTOCOLS = ["ocpp2.0.1", "ocpp2.0", "ocpp1.6"];
