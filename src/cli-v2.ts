import { resolve } from "node:path"
import { Api } from "./api"
import { ApiClient } from "./api-client"
import { HttpServer } from "./http-server"

const DEFAULT_DATA_DIR = "data"
const DEFAULT_SERVER_URL = "http://127.0.0.1:1234"

async function main() {
  const [resource, action, ...rest] = Bun.argv.slice(2)
  const flags = parseFlags(rest)

  if (resource === "server" && action === "start") {
    const server = new HttpServer({
      dataDir: resolve(flags.get("--data-dir") ?? DEFAULT_DATA_DIR),
      hostname: flags.get("--host"),
      port: flags.has("--port") ? Number.parseInt(required(flags, "--port"), 10) : undefined,
    })
    await server.listen()
    return
  }

  if (resource !== "images") {
    throw new Error(usage())
  }

  const api = createApi(flags)

  if (action === "list") {
    const images = await api.listImages()
    for (const image of images) {
      console.log(`${image.id} ${image.status} ${image.name} ${image.progress}`)
    }
    return
  }

  if (action === "create") {
    const name = required(flags, "--name")
    const url = required(flags, "--url")
    const image = await api.createImage({ name, url })
    console.log(`${image.id} ${image.status} ${image.name}`)
    const completedImage = await waitForImage(api, image.id)
    console.log(`${completedImage.id} ${completedImage.status} ${completedImage.name} ${completedImage.progress}`)
    return
  }

  throw new Error(usage())
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
    throw new Error(`Missing required ${name}\n\n${usage()}`)
  }
  return value
}

function usage(): string {
  return [
    "Usage:",
    "  bun src/cli-v2.ts server start [--data-dir ./data] [--host 0.0.0.0] [--port 1234]",
    "  bun src/cli-v2.ts images list [--server http://127.0.0.1:1234]",
    "  bun src/cli-v2.ts images create --name debian-13 --url https://... [--server http://127.0.0.1:1234]",
  ].join("\n")
}

function createApi(flags: Map<string, string>): Api {
  return new ApiClient(flags.get("--server") ?? DEFAULT_SERVER_URL)
}

async function waitForImage(api: Api, id: string) {
  while (true) {
    const image = (await api.listImages()).find((candidate) => candidate.id === id)
    if (!image) {
      throw new Error(`Image not found after create: ${id}`)
    }

    if (image.status === "ready") {
      return image
    }

    if (image.status !== "downloading") {
      throw new Error(image.error ?? `Image creation failed: ${image.status}`)
    }

    await Bun.sleep(100)
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
