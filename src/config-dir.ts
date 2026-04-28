import { homedir } from "node:os";
import { join } from "node:path";

export function defaultConfigDir(): string {
  return process.env.VMLOT_CONFIG_DIR ?? join(homedir(), ".config", "vmlot");
}
