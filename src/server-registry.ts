import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export interface ServerEndpoint {
  host: string;
  port: number;
}

export interface RegisteredServer {
  endpoint: ServerEndpoint;
}

type ServerRegistryFile = Record<string, RegisteredServer>;

export interface ServerRegistryEntry {
  name: string;
  endpoint: ServerEndpoint;
}

const DEFAULT_SERVER_PORT = 10450;
const DEFAULT_LOCAL_SERVER_URL = `http://127.0.0.1:${DEFAULT_SERVER_PORT}`;
const SERVER_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export class ServerRegistry {
  constructor(private readonly path = defaultServerRegistryPath()) {}

  static defaultPath(): string {
    return defaultServerRegistryPath();
  }

  async list(): Promise<ServerRegistryEntry[]> {
    const servers = await this.read();
    return Object.entries(servers)
      .map(([name, server]) => ({
        name,
        endpoint: server.endpoint,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async add(name: string, endpoint: ServerEndpoint): Promise<void> {
    validateServerName(name);
    validateEndpoint(endpoint);

    const servers = await this.read();
    servers[name] = { endpoint };
    await this.write(servers);
  }

  async remove(name: string): Promise<void> {
    validateServerName(name);

    const servers = await this.read();
    if (!(name in servers)) {
      throw new Error(`Unknown server: ${name}`);
    }

    delete servers[name];
    await this.write(servers);
  }

  async resolve(nameOrUrl: string): Promise<string> {
    if (isUrl(nameOrUrl)) {
      return nameOrUrl;
    }

    if (nameOrUrl === "local") {
      return DEFAULT_LOCAL_SERVER_URL;
    }

    validateServerName(nameOrUrl);
    const servers = await this.read();
    const server = servers[nameOrUrl];
    if (!server) {
      throw new Error(`Unknown server: ${nameOrUrl}`);
    }

    validateEndpoint(server.endpoint);
    return endpointUrl(server.endpoint);
  }

  private async read(): Promise<ServerRegistryFile> {
    try {
      const file = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      if (!isServerRegistryFile(file)) {
        throw new Error(`Invalid server registry file: ${this.path}`);
      }
      return file;
    } catch (error: unknown) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? (error as { code?: string }).code
          : undefined;
      if (code === "ENOENT") {
        return {};
      }

      throw error;
    }
  }

  private async write(servers: ServerRegistryFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify(servers, null, 2)}\n`);
  }
}

function defaultServerRegistryPath(): string {
  const configDir =
    process.env.VMLOT_CONFIG_DIR ?? join(homedir(), ".config", "vmlot");
  return join(configDir, "servers.json");
}

function validateServerName(name: string): void {
  if (!SERVER_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid server name: ${name}. Use letters, numbers, dots, underscores, or dashes.`,
    );
  }
}

function validateEndpoint(endpoint: ServerEndpoint): void {
  if (
    endpoint.host.trim().length === 0 ||
    endpoint.host.includes("/") ||
    endpoint.host.includes("://")
  ) {
    throw new Error(`Invalid server host: ${endpoint.host}`);
  }

  if (
    !Number.isInteger(endpoint.port) ||
    endpoint.port < 1 ||
    endpoint.port > 65535
  ) {
    throw new Error(`Invalid server port: ${endpoint.port}`);
  }
}

export function endpointUrl(endpoint: ServerEndpoint): string {
  const host =
    endpoint.host.includes(":") && !endpoint.host.startsWith("[")
      ? `[${endpoint.host}]`
      : endpoint.host;
  return `http://${host}:${endpoint.port}`;
}

function isUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isServerRegistryFile(value: unknown): value is ServerRegistryFile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  return Object.values(value).every(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      "endpoint" in entry &&
      typeof entry.endpoint === "object" &&
      entry.endpoint !== null &&
      "host" in entry.endpoint &&
      typeof entry.endpoint.host === "string" &&
      "port" in entry.endpoint &&
      typeof entry.endpoint.port === "number",
  );
}
