import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { homedir } from "node:os"
import { Api } from "./api"
import { ApiClient } from "./api-client"
import { HttpServer } from "./http-server"

const DEFAULT_DATA_DIR = "data"
const DEFAULT_SERVER_URL = "http://127.0.0.1:1234"
const DEFAULT_VM_MEMORY = 2048
const DEFAULT_VM_VCPU = 2

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

  const api = createApi(flags)

  if (resource === "images" && action === "list") {
    const images = await api.listImages()
    for (const image of images) {
      console.log(`${image.id} ${image.status} ${image.name} ${image.progress}`)
    }
    return
  }

  if (resource === "images" && action === "create") {
    const name = required(flags, "--name")
    const url = required(flags, "--url")
    const image = await api.createImage({ name, url })
    console.log(`${image.id} ${image.status} ${image.name}`)
    const completedImage = await waitForImage(api, image.id)
    console.log(`${completedImage.id} ${completedImage.status} ${completedImage.name} ${completedImage.progress}`)
    return
  }

  if (resource === "vms" && action === "list") {
    const vms = await api.listVms()
    for (const vm of vms) {
      console.log(`${vm.id} ${vm.status} ${vm.name} ${vm.baseImageName} ${vm.memory} ${vm.vcpu}`)
    }
    return
  }

  if (resource === "vms" && action === "create") {
    const baseImageId = await resolveBaseImageId(api, required(flags, "--base-image"))
    const vm = await api.createVm({
      name: required(flags, "--name"),
      baseImageId,
      user: required(flags, "--user"),
      sshPublicKey: await resolveValue(required(flags, "--ssh-public-key")),
      tailscaleAuthKey: required(flags, "--tailscale-auth-key"),
      memory: flags.has("--memory") ? parseIntegerFlag(flags, "--memory") : DEFAULT_VM_MEMORY,
      vcpu: flags.has("--vcpu") ? parseIntegerFlag(flags, "--vcpu") : DEFAULT_VM_VCPU,
    })
    console.log(`${vm.id} ${vm.status} ${vm.name}`)
    const completedVm = await waitForVm(api, vm.id)
    console.log(`${completedVm.id} ${completedVm.status} ${completedVm.name} ${completedVm.baseImageName}`)
    return
  }

  if (resource === "vms" && action === "remove") {
    await api.removeVm(required(flags, "--id"))
    console.log(`removed ${required(flags, "--id")}`)
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
    "  bun src/cli-v2.ts vms list [--server http://127.0.0.1:1234]",
    "  bun src/cli-v2.ts vms create --name vm01 --base-image debian-13 --user debian --ssh-public-key ~/.ssh/id_ed25519.pub --tailscale-auth-key tskey-... [--memory 2048] [--vcpu 2] [--server http://127.0.0.1:1234]",
    "  bun src/cli-v2.ts vms remove --id <vm-id> [--server http://127.0.0.1:1234]",
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

async function waitForVm(api: Api, id: string) {
  while (true) {
    const vm = (await api.listVms()).find((candidate) => candidate.id === id)
    if (!vm) {
      throw new Error(`VM not found after create: ${id}`)
    }

    if (vm.status === "stopped" || vm.status === "running") {
      return vm
    }

    if (vm.status !== "creating") {
      throw new Error(vm.error ?? `VM creation failed: ${vm.status}`)
    }

    await Bun.sleep(100)
  }
}

async function resolveBaseImageId(api: Api, value: string): Promise<string> {
  const images = await api.listImages()

  const directMatch = images.find((image) => image.id === value)
  if (directMatch) {
    if (directMatch.status !== "ready") {
      throw new Error(`Base image is not ready: ${directMatch.name} (${directMatch.status})`)
    }
    return directMatch.id
  }

  const nameMatches = images.filter((image) => image.name === value)
  if (nameMatches.length === 0) {
    throw new Error(`Base image not found: ${value}`)
  }

  const readyMatches = nameMatches.filter((image) => image.status === "ready")
  if (readyMatches.length !== 1) {
    throw new Error(`Base image name must resolve to one ready image: ${value}`)
  }

  return readyMatches[0].id
}

function parseIntegerFlag(flags: Map<string, string>, name: string): number {
  const value = Number.parseInt(required(flags, name), 10)
  if (!Number.isInteger(value)) {
    throw new Error(`Invalid integer for ${name}: ${required(flags, name)}`)
  }
  return value
}

async function resolveValue(value: string): Promise<string> {
  const explicitPath = value.startsWith("@") ? value.slice(1) : null
  const candidatePath = explicitPath ?? value

  if (explicitPath || looksLikeFilePath(candidatePath)) {
    const path = resolvePath(candidatePath)
    return (await readFile(path, "utf8")).trim()
  }

  return value
}

function resolvePath(value: string) {
  if (value === "~") {
    return homedir()
  }

  if (value.startsWith("~/")) {
    return join(homedir(), value.slice(2))
  }

  return resolve(value)
}

function looksLikeFilePath(value: string) {
  return value.startsWith("/") || value.startsWith("./") || value.startsWith("../") || value.startsWith("~")
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
