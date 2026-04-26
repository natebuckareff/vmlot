import { resolve } from "node:path"
import { ApiServer } from "./api-server"

interface HttpServerOptions {
  dataDir?: string
  hostname?: string
  port?: number
}

export class HttpServer {
  private readonly api: ApiServer
  private readonly hostname: string
  private readonly port: number

  constructor(options: HttpServerOptions = {}) {
    this.api = new ApiServer(resolve(options.dataDir ?? "data"))
    this.hostname = options.hostname ?? "0.0.0.0"
    this.port = options.port ?? 1234
  }

  async listen(): Promise<void> {
    Bun.serve({
      hostname: this.hostname,
      port: this.port,
      fetch: (request) => this.handleRequest(request),
    })

    console.log(`Listening on http://${this.hostname}:${this.port}`)
    await new Promise<void>(() => {})
  }

  private async handleRequest(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return jsonResponse(405, {
        error: {
          message: `Unsupported method: ${request.method}`,
        },
      })
    }

    try {
      const pathname = new URL(request.url).pathname
      const body = await this.parseRequestBody(request)

      if (pathname === "/api/list-vms") {
        return jsonResponse(200, { data: await this.api.listVms() })
      }

      if (pathname === "/api/list-images") {
        return jsonResponse(200, { data: await this.api.listImages() })
      }

      if (pathname === "/api/create-vm") {
        if (!isCreateVmBody(body)) {
          return jsonResponse(400, {
            error: {
              message: "Invalid create-vm request body",
            },
          })
        }

        return jsonResponse(200, {
          data: await this.api.createVm(body),
        })
      }

      if (pathname === "/api/remove-vm") {
        if (!isRemoveVmBody(body)) {
          return jsonResponse(400, {
            error: {
              message: "Invalid remove-vm request body",
            },
          })
        }

        await this.api.removeVm(body.id)
        return jsonResponse(200, { data: null })
      }

      if (pathname === "/api/create-image") {
        if (!isCreateImageBody(body)) {
          return jsonResponse(400, {
            error: {
              message: "Invalid create-image request body",
            },
          })
        }

        return jsonResponse(200, {
          data: await this.api.createImage(body),
        })
      }

      return jsonResponse(404, {
        error: {
          message: `Unknown endpoint: ${pathname}`,
        },
      })
    } catch (error: unknown) {
      return jsonResponse(500, {
        error: {
          message: error instanceof Error ? error.message : String(error),
        },
      })
    }
  }

  private async parseRequestBody(request: Request): Promise<unknown> {
    const contentType = request.headers.get("content-type") ?? ""
    if (!contentType.includes("application/json")) {
      return {}
    }

    return request.json()
  }
}

function isCreateImageBody(body: unknown): body is { name: string; url: string } {
  return (
    typeof body === "object" &&
    body !== null &&
    "name" in body &&
    typeof body.name === "string" &&
    "url" in body &&
    typeof body.url === "string"
  )
}

function isCreateVmBody(
  body: unknown,
): body is {
  name: string
  baseImageId: string
  user: string
  sshPublicKey: string
  tailscaleAuthKey: string
  memory: number
  vcpu: number
} {
  return (
    typeof body === "object" &&
    body !== null &&
    "name" in body &&
    typeof body.name === "string" &&
    "baseImageId" in body &&
    typeof body.baseImageId === "string" &&
    "user" in body &&
    typeof body.user === "string" &&
    "sshPublicKey" in body &&
    typeof body.sshPublicKey === "string" &&
    "tailscaleAuthKey" in body &&
    typeof body.tailscaleAuthKey === "string" &&
    "memory" in body &&
    typeof body.memory === "number" &&
    "vcpu" in body &&
    typeof body.vcpu === "number"
  )
}

function isRemoveVmBody(body: unknown): body is { id: string } {
  return (
    typeof body === "object" &&
    body !== null &&
    "id" in body &&
    typeof body.id === "string"
  )
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  })
}

if (import.meta.main) {
  const flags = parseFlags(Bun.argv.slice(2))
  const server = new HttpServer({
    dataDir: flags.get("--data-dir"),
    hostname: flags.get("--host"),
    port: flags.has("--port") ? Number.parseInt(required(flags, "--port"), 10) : undefined,
  })

  server.listen().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}

function parseFlags(argv: string[]): Map<string, string> {
  const values = new Map<string, string>()

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`)
    }

    const [flag, inlineValue] = arg.split("=", 2)
    const value = inlineValue ?? argv[index + 1]
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${flag}`)
    }

    if (inlineValue === undefined) {
      index += 1
    }

    values.set(flag, value)
  }

  return values
}

function required(flags: Map<string, string>, name: string): string {
  const value = flags.get(name)
  if (!value) {
    throw new Error(`Missing required ${name}`)
  }

  return value
}
