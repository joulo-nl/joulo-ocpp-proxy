import { loadConfig } from "./config";
import { setLogLevel } from "./logger";
import { startProxy } from "./proxy";

const config = loadConfig();
setLogLevel(config.logLevel);
startProxy(config);
