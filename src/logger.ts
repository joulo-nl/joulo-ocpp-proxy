type Level = "debug" | "info" | "warn" | "error";

const LEVEL_WEIGHT: Record<Level, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let minLevel: Level = "info";

export function setLogLevel(level: Level): void {
  minLevel = level;
}

function log(level: Level, tag: string, message: string, extra?: object) {
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[minLevel]) return;

  const entry: Record<string, unknown> = {
    time: new Date().toISOString(),
    level,
    tag,
    msg: message,
    ...extra,
  };

  const line = JSON.stringify(entry);

  if (level === "error") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

export function createLogger(tag: string) {
  return {
    debug: (msg: string, extra?: object) => log("debug", tag, msg, extra),
    info: (msg: string, extra?: object) => log("info", tag, msg, extra),
    warn: (msg: string, extra?: object) => log("warn", tag, msg, extra),
    error: (msg: string, extra?: object) => log("error", tag, msg, extra),
  };
}
