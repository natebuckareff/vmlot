import { resolve } from "node:path";
import { ApiServer } from "./api-server";
import { DataDir } from "./data-dir";
import { ServerConfig } from "./server-config";
import { TailscaleClient } from "./tailscale-client";
import type { CreateVmInput } from "./vm";

interface HttpServerOptions {
  dataDir?: string;
  hostname?: string;
  port?: number;
}

const DEFAULT_SERVER_PORT = 10450;

export class HttpServer {
  private readonly api: ApiServer;
  private readonly hostname: string;
  private readonly port: number;

  constructor(api: ApiServer, options: HttpServerOptions = {}) {
    this.api = api;
    this.hostname = options.hostname ?? "0.0.0.0";
    this.port = options.port ?? DEFAULT_SERVER_PORT;
  }

  static async create(options: HttpServerOptions = {}): Promise<HttpServer> {
    const dataDir = resolve(options.dataDir ?? "data");
    const serverConfig = new ServerConfig(dataDir);
    const config = await serverConfig.read();
    const tailscale = TailscaleClient.fromConfig(config.tailscale);
    const api = new ApiServer({
      dataDir: new DataDir(dataDir),
      tailscale,
    });
    await api.initialize();

    return new HttpServer(api, { ...options, dataDir });
  }

  async listen(): Promise<void> {
    Bun.serve({
      hostname: this.hostname,
      port: this.port,
      fetch: (request) => this.handleRequest(request),
    });

    console.log(`Listening on http://${this.hostname}:${this.port}`);
    await new Promise<void>(() => {});
  }

  private async handleRequest(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return jsonResponse(405, {
        error: {
          message: `Unsupported method: ${request.method}`,
        },
      });
    }

    try {
      const pathname = new URL(request.url).pathname;
      const body = await this.parseRequestBody(request);

      if (pathname === "/api/ping") {
        return jsonResponse(200, { data: null });
      }

      if (pathname === "/api/list-vms") {
        return jsonResponse(200, { data: await this.api.listVms() });
      }

      if (pathname === "/api/list-images") {
        return jsonResponse(200, { data: await this.api.listImages() });
      }

      if (pathname === "/api/create-vm") {
        if (!isCreateVmBody(body)) {
          return jsonResponse(400, {
            error: {
              message: "Invalid create-vm request body",
            },
          });
        }

        return jsonResponse(200, {
          data: await this.api.createVm(body),
        });
      }

      if (pathname === "/api/remove-image") {
        if (!isRemoveVmBody(body)) {
          return jsonResponse(400, {
            error: {
              message: "Invalid remove-image request body",
            },
          });
        }

        await this.api.removeImage(body.id);
        return jsonResponse(200, { data: null });
      }

      if (pathname === "/api/remove-vm") {
        if (!isRemoveVmBody(body)) {
          return jsonResponse(400, {
            error: {
              message: "Invalid remove-vm request body",
            },
          });
        }

        await this.api.removeVm(body.id);
        return jsonResponse(200, { data: null });
      }

      if (pathname === "/api/start-vm") {
        if (!isRemoveVmBody(body)) {
          return jsonResponse(400, {
            error: {
              message: "Invalid start-vm request body",
            },
          });
        }

        await this.api.startVm(body.id);
        return jsonResponse(200, { data: null });
      }

      if (pathname === "/api/stop-vm") {
        if (!isRemoveVmBody(body)) {
          return jsonResponse(400, {
            error: {
              message: "Invalid stop-vm request body",
            },
          });
        }

        await this.api.stopVm(body.id);
        return jsonResponse(200, { data: null });
      }

      if (pathname === "/api/create-image") {
        if (!isCreateImageBody(body)) {
          return jsonResponse(400, {
            error: {
              message: "Invalid create-image request body",
            },
          });
        }

        return jsonResponse(200, {
          data: await this.api.createImage(body),
        });
      }

      return jsonResponse(404, {
        error: {
          message: `Unknown endpoint: ${pathname}`,
        },
      });
    } catch (error: unknown) {
      return jsonResponse(500, {
        error: {
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private async parseRequestBody(request: Request): Promise<unknown> {
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      return {};
    }

    return request.json();
  }
}

function isCreateImageBody(
  body: unknown,
): body is { name: string; url: string } {
  return (
    typeof body === "object" &&
    body !== null &&
    "name" in body &&
    typeof body.name === "string" &&
    "url" in body &&
    typeof body.url === "string"
  );
}

function isCreateVmBody(body: unknown): body is CreateVmInput {
  return (
    typeof body === "object" &&
    body !== null &&
    "name" in body &&
    typeof body.name === "string" &&
    "baseImageId" in body &&
    typeof body.baseImageId === "string" &&
    (!("user" in body) ||
      body.user === undefined ||
      typeof body.user === "string") &&
    "sshPublicKey" in body &&
    typeof body.sshPublicKey === "string" &&
    "memory" in body &&
    typeof body.memory === "number" &&
    "vcpu" in body &&
    typeof body.vcpu === "number"
  );
}

function isRemoveVmBody(body: unknown): body is { id: string } {
  return (
    typeof body === "object" &&
    body !== null &&
    "id" in body &&
    typeof body.id === "string"
  );
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}
