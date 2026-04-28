import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultConfigDir } from "./config-dir";

export interface TailscaleConfig {
  oauthClientId: string;
  oauthClientSecret: string;
  authKeyExpirySeconds: number;
  tags: string[];
  tailnet: string;
}

export interface ServerConfigData {
  tailscale: TailscaleConfig;
}

interface ServerConfigFile {
  tailscale: TailscaleConfigFile;
}

interface TailscaleConfigFile {
  oauthClientId?: string;
  oauthClientSecret?: string;
  authKeyExpirySeconds?: number;
  tags?: string[];
  tailnet?: string;
}

export class ServerConfig {
  constructor(private readonly path = defaultServerConfigPath()) {}

  static defaultPath(): string {
    return defaultServerConfigPath();
  }

  async read(): Promise<ServerConfigData> {
    const file = JSON.parse(await this.readConfigFile()) as ServerConfigFile;
    const tailscale = file.tailscale;

    return {
      tailscale: {
        oauthClientId: requiredString(
          tailscale.oauthClientId,
          "tailscale.oauthClientId",
        ),
        oauthClientSecret: requiredString(
          tailscale.oauthClientSecret,
          "tailscale.oauthClientSecret",
        ),
        authKeyExpirySeconds: requiredPositiveInteger(
          tailscale.authKeyExpirySeconds,
          "tailscale.authKeyExpirySeconds",
        ),
        tags: requiredStringArray(tailscale.tags, "tailscale.tags"),
        tailnet: optionalString(tailscale.tailnet) ?? "-",
      },
    };
  }

  private async readConfigFile(): Promise<string> {
    try {
      return await readFile(this.path, "utf8");
    } catch (error: unknown) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? (error as { code?: string }).code
          : undefined;
      if (code === "ENOENT") {
        throw new Error(`Missing config file: ${this.path}`);
      }

      throw error;
    }
  }
}

export function isMissingServerConfigError(error: unknown): boolean {
  return (
    error instanceof Error && error.message.startsWith("Missing config file: ")
  );
}

function defaultServerConfigPath(): string {
  return join(defaultConfigDir(), "config.json");
}

function requiredString(value: string | undefined, fieldName: string): string {
  const normalized = optionalString(value);
  if (!normalized) {
    throw new Error(`Missing required config field: ${fieldName}`);
  }

  return normalized;
}

function optionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function requiredPositiveInteger(
  value: number | undefined,
  fieldName: string,
): number {
  if (value == undefined || !Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid required config field: ${fieldName}`);
  }

  return value;
}

function requiredStringArray(
  value: string[] | undefined,
  fieldName: string,
): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`Missing required config field: ${fieldName}`);
  }

  const normalized = value
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (normalized.length === 0) {
    throw new Error(
      `Config field must include at least one value: ${fieldName}`,
    );
  }

  return normalized;
}
