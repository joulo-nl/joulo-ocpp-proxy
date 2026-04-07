export interface Config {
  port: number;
  primaryUrl: string;
  secondaryUrls: string[];
  logLevel: "debug" | "info" | "warn" | "error";
}

const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export function loadConfig(): Config {
  const primaryUrl = process.env.PRIMARY_CSMS_URL;
  if (!primaryUrl) {
    throw new Error(
      "PRIMARY_CSMS_URL is required. Set it to your primary CSMS WebSocket URL."
    );
  }

  const raw = process.env.SECONDARY_CSMS_URLS ?? "";
  const secondaryUrls = raw
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);

  const level = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  const logLevel = LOG_LEVELS.includes(level as any)
    ? (level as Config["logLevel"])
    : "info";

  return {
    port: parseInt(process.env.PORT ?? "9000", 10),
    primaryUrl,
    secondaryUrls,
    logLevel,
  };
}
