import { createHash } from "node:crypto"
import { mkdir, open, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises"
import { basename, extname, join, relative, resolve } from "node:path"
import { homedir } from "node:os"

const DEFAULT_OUTPUT_DIR = "build"
const DEFAULT_TEMPLATE_DIR = "templates"
const DEFAULT_REMOTE_ROOT = "/srv/vms"

type Command = "build" | "deploy"

type BuildArgs = {
  instance: string
  user: string
  sshPublicKey: string
  tailscaleAuthKey: string
  baseImageUrl: string
  outputDir: string
  templateDir: string
  remoteRoot: string
}

type DeployArgs = {
  instance: string
  server: string
  outputDir: string
  remoteRoot: string
  dryRun: boolean
}

type DeployArtifacts = {
  instance: string
  localVmDir: string
  localVmXmlPath: string
  localDiskPath: string
  localSeedIsoPath: string
  localBaseImagePath: string
  remoteRoot: string
}

type VmHostApiClient = {
  ensureVmDirectory(artifacts: DeployArtifacts): Promise<void>
  vmExists(instance: string): Promise<boolean>
  baseImageExists(baseImageName: string, remoteRoot: string): Promise<boolean>
  uploadBaseImage(artifacts: DeployArtifacts): Promise<void>
  uploadVmArtifacts(artifacts: DeployArtifacts): Promise<void>
  defineAndStartVm(artifacts: DeployArtifacts): Promise<void>
}

async function main() {
  const cli = await parseCli(Bun.argv.slice(2))

  if (cli.command === "build") {
    await buildInstance(cli.args)
    return
  }

  await deployInstance(cli.args)
}

async function buildInstance(args: BuildArgs) {
  const instance = validateInstanceName(args.instance)
  const templateDir = resolve(args.templateDir)
  const outputRootDir = resolve(args.outputDir)
  const outputDir = join(outputRootDir, instance)
  const artifactPaths = getArtifactPaths(outputRootDir, instance)

  await assertPathDoesNotExist(outputDir, `VM output directory already exists: ${outputDir}`)

  const userDataTemplatePath = join(templateDir, "user-data.yml")
  const metaDataTemplatePath = join(templateDir, "meta-data.yml")
  const networkConfigTemplatePath = join(templateDir, "network-config.yml")
  const vmXmlTemplatePath = join(templateDir, "vm.xml")

  await assertFileExists(userDataTemplatePath)
  await assertFileExists(metaDataTemplatePath)
  await assertFileExists(networkConfigTemplatePath)
  await assertFileExists(vmXmlTemplatePath)

  const replacements = {
    NAME: instance,
    USER: args.user.trim(),
    PUBLIC_KEY: args.sshPublicKey.trim(),
    TS_AUTH_KEY: args.tailscaleAuthKey.trim(),
    REMOTE_ROOT: normalizeRemoteRoot(args.remoteRoot),
  }

  const userData = renderTemplate(await readFile(userDataTemplatePath, "utf8"), replacements)
  const metaData = renderTemplate(await readFile(metaDataTemplatePath, "utf8"), replacements)
  const vmXml = renderTemplate(await readFile(vmXmlTemplatePath, "utf8"), replacements)

  const baseImagePath = await downloadBaseImage(args.baseImageUrl, outputRootDir)
  console.log(`Using base image ${baseImagePath}`)

  await mkdir(outputDir, { recursive: true })

  try {
    await writeFile(artifactPaths.renderedUserDataPath, userData)
    await writeFile(artifactPaths.renderedMetaDataPath, metaData)
    await writeFile(artifactPaths.renderedVmXmlPath, vmXml)
    await Bun.write(artifactPaths.renderedNetworkConfigPath, Bun.file(networkConfigTemplatePath))

    console.log(`Rendering cloud-init into ${outputDir}`)
    await createLinkedDisk(baseImagePath, artifactPaths.vmDiskPath, outputDir)

    runCommand(
      [
        "cloud-localds",
        `--network-config=${artifactPaths.renderedNetworkConfigPath}`,
        artifactPaths.seedIsoPath,
        artifactPaths.renderedUserDataPath,
        artifactPaths.renderedMetaDataPath,
      ],
      {
        cwd: outputDir,
        errorPrefix: "cloud-localds failed",
      },
    )

    console.log(`Wrote ${artifactPaths.seedIsoPath}`)
    console.log(`Wrote ${artifactPaths.vmDiskPath}`)
    console.log(`Wrote ${artifactPaths.renderedVmXmlPath}`)
  } catch (error) {
    await removeDirectoryIfPresent(outputDir)
    throw error
  }
}

async function deployInstance(args: DeployArgs) {
  const instance = validateInstanceName(args.instance)
  const outputRootDir = resolve(args.outputDir)
  const outputDir = join(outputRootDir, instance)
  const artifactPaths = getArtifactPaths(outputRootDir, instance)
  const remoteRoot = normalizeRemoteRoot(args.remoteRoot)

  await assertLocalDeployArtifacts(outputDir, artifactPaths)

  const baseImagePath = await resolveBackingFilePath(artifactPaths.vmDiskPath, outputDir)
  await assertFileExists(baseImagePath)
  const artifacts: DeployArtifacts = {
    instance,
    localVmDir: outputDir,
    localVmXmlPath: artifactPaths.renderedVmXmlPath,
    localDiskPath: artifactPaths.vmDiskPath,
    localSeedIsoPath: artifactPaths.seedIsoPath,
    localBaseImagePath: baseImagePath,
    remoteRoot,
  }
  const api = createMockVmHostApiClient(args.server, args.dryRun)

  console.log(`${args.dryRun ? "Planning" : "Calling"} deploy API for ${args.server}`)

  if (args.dryRun) {
    printDryRunSummary(args.server, artifacts)
    return
  }

  await api.ensureVmDirectory(artifacts)
  const vmExists = await api.vmExists(instance)

  if (vmExists) {
    throw new Error(`VM already exists remotely: ${instance}`)
  }

  const remoteBaseExists = await api.baseImageExists(basename(baseImagePath), remoteRoot)

  if (!remoteBaseExists) {
    await api.uploadBaseImage(artifacts)
  } else {
    console.log(`Remote base image already present for ${basename(baseImagePath)}`)
  }

  await api.uploadVmArtifacts(artifacts)
  await api.defineAndStartVm(artifacts)

  console.log(`Mock-deployed ${instance} via API target ${args.server}`)
}

async function parseCli(argv: string[]) {
  const [command, ...rest] = argv

  if (!command) {
    throw new Error(usage())
  }

  if (command === "build") {
    return {
      command,
      args: await parseBuildArgs(rest),
    } as const
  }

  if (command === "deploy") {
    return {
      command,
      args: parseDeployArgs(rest),
    } as const
  }

  throw new Error(`Unknown subcommand: ${command}\n\n${usage()}`)
}

async function parseBuildArgs(argv: string[]): Promise<BuildArgs> {
  const values = parseFlagValues(argv)

  return {
    instance: required(values, "--instance"),
    user: required(values, "--user"),
    sshPublicKey: await resolveValue(required(values, "--ssh-public-key")),
    tailscaleAuthKey: required(values, "--tailscale-auth-key"),
    baseImageUrl: required(values, "--base-image-url"),
    outputDir: values.get("--output-dir") ?? DEFAULT_OUTPUT_DIR,
    templateDir: values.get("--template-dir") ?? DEFAULT_TEMPLATE_DIR,
    remoteRoot: values.get("--remote-root") ?? DEFAULT_REMOTE_ROOT,
  }
}

function parseDeployArgs(argv: string[]): DeployArgs {
  const values = parseFlagValues(argv)

  return {
    instance: required(values, "--instance"),
    server: required(values, "--server"),
    outputDir: values.get("--output-dir") ?? DEFAULT_OUTPUT_DIR,
    remoteRoot: values.get("--remote-root") ?? DEFAULT_REMOTE_ROOT,
    dryRun: values.has("--dry-run"),
  }
}

function parseFlagValues(argv: string[]) {
  const values = new Map<string, string>()

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]

    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`)
    }

    if (arg === "--dry-run") {
      values.set(arg, "true")
      continue
    }

    const [flag, inlineValue] = arg.split("=", 2)
    const nextValue = argv[index + 1]
    const value = inlineValue ?? nextValue

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

function required(values: Map<string, string>, flag: string): string {
  const value = values.get(flag)

  if (!value) {
    throw new Error(`Missing required ${flag}\n\n${usage()}`)
  }

  return value
}

function usage() {
  return [
    "Usage:",
    "  bun run cloud.ts build --instance vm01 --user debian --ssh-public-key ~/.ssh/id_ed25519.pub --tailscale-auth-key tskey-... --base-image-url https://... [--remote-root /srv/vms]",
    "  bun run cloud.ts deploy --instance vm01 --server storage [--remote-root /srv/vms] [--dry-run]",
  ].join("\n")
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

async function assertFileExists(path: string) {
  try {
    await stat(path)
  } catch (error: unknown) {
    const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: string }).code : undefined
    if (code === "ENOENT") {
      throw new Error(`Required file not found: ${path}`)
    }

    throw error
  }
}

async function assertPathDoesNotExist(path: string, message: string) {
  try {
    await stat(path)
  } catch (error: unknown) {
    const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: string }).code : undefined
    if (code === "ENOENT") {
      return
    }

    throw error
  }

  throw new Error(message)
}

async function downloadBaseImage(url: string, outputRootDir: string) {
  const parsedUrl = new URL(url)
  const filename = localFilenameForUrl(parsedUrl)
  const destinationPath = join(outputRootDir, filename)
  const destinationFile = Bun.file(destinationPath)

  if (await destinationFile.exists()) {
    return destinationPath
  }

  const tempPath = `${destinationPath}.download`

  console.log(`Downloading ${url}`)
  const response = await fetch(parsedUrl)

  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`)
  }

  try {
    await writeResponseWithProgress(response, tempPath)
    await rename(tempPath, destinationPath)
  } catch (error) {
    await unlinkIfPresent(tempPath)
    throw error
  }

  return destinationPath
}

async function createLinkedDisk(baseImagePath: string, vmDiskPath: string, vmDir: string) {
  const relativeBackingPath = relative(vmDir, baseImagePath)

  runCommand(["qemu-img", "create", "-f", "qcow2", "-F", "qcow2", "-b", relativeBackingPath, vmDiskPath], {
    cwd: vmDir,
    errorPrefix: "qemu-img create failed",
  })
}

function localFilenameForUrl(url: URL) {
  const baseName = basename(url.pathname)

  if (baseName) {
    return baseName
  }

  const extension = extname(url.pathname) || ".qcow2"
  const digest = createHash("sha256").update(url.toString()).digest("hex").slice(0, 16)
  return `base-${digest}${extension}`
}

function looksLikeFilePath(value: string) {
  return value.startsWith("/") || value.startsWith("./") || value.startsWith("../") || value.startsWith("~")
}

async function writeResponseWithProgress(response: Response, destinationPath: string) {
  if (!response.body) {
    throw new Error("Download response did not include a body")
  }

  const totalBytesHeader = response.headers.get("content-length")
  const totalBytes = totalBytesHeader ? Number.parseInt(totalBytesHeader, 10) : Number.NaN
  const hasKnownLength = Number.isFinite(totalBytes) && totalBytes > 0

  const file = await open(destinationPath, "w")
  const reader = response.body.getReader()
  let downloadedBytes = 0
  let lastRenderAt = 0

  try {
    while (true) {
      const { done, value } = await reader.read()

      if (done) {
        break
      }

      if (!value) {
        continue
      }

      await file.write(value)
      downloadedBytes += value.byteLength

      const now = Date.now()
      if (now - lastRenderAt >= 100) {
        renderProgress(downloadedBytes, hasKnownLength ? totalBytes : null)
        lastRenderAt = now
      }
    }

    renderProgress(downloadedBytes, hasKnownLength ? totalBytes : null)
    process.stdout.write("\n")
  } finally {
    await file.close()
  }
}

function renderProgress(downloadedBytes: number, totalBytes: number | null) {
  const downloadedLabel = formatBytes(downloadedBytes)

  if (!totalBytes) {
    process.stdout.write(`\rDownloaded ${downloadedLabel}`)
    return
  }

  const width = 24
  const ratio = Math.min(downloadedBytes / totalBytes, 1)
  const filled = Math.round(ratio * width)
  const bar = `${"=".repeat(Math.max(filled - 1, 0))}${filled > 0 ? ">" : ""}${" ".repeat(width - filled)}`
  const percent = (ratio * 100).toFixed(1).padStart(5, " ")
  const totalLabel = formatBytes(totalBytes)

  process.stdout.write(`\r[${bar}] ${percent}% ${downloadedLabel}/${totalLabel}`)
}

function formatBytes(bytes: number) {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"]
  let value = bytes
  let unitIndex = 0

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }

  const digits = unitIndex === 0 ? 0 : value >= 10 ? 1 : 2
  return `${value.toFixed(digits)} ${units[unitIndex]}`
}

function renderTemplate(template: string, replacements: Record<string, string>) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key: string) => {
    const replacement = replacements[key]

    if (replacement === undefined) {
      throw new Error(`No replacement found for template token {{${key}}}`)
    }

    return replacement
  })
}

function getArtifactPaths(outputRootDir: string, instance: string) {
  const outputDir = join(outputRootDir, instance)

  return {
    outputDir,
    renderedUserDataPath: join(outputDir, "user-data"),
    renderedMetaDataPath: join(outputDir, "meta-data"),
    renderedNetworkConfigPath: join(outputDir, "network-config"),
    renderedVmXmlPath: join(outputDir, "vm.xml"),
    seedIsoPath: join(outputDir, "seed.iso"),
    vmDiskPath: join(outputDir, "disk.qcow2"),
  }
}

async function assertLocalDeployArtifacts(outputDir: string, artifactPaths: ReturnType<typeof getArtifactPaths>) {
  await assertDirectoryExists(outputDir, `VM output directory not found: ${outputDir}`)
  await assertFileExists(artifactPaths.renderedVmXmlPath)
  await assertFileExists(artifactPaths.vmDiskPath)
  await assertFileExists(artifactPaths.seedIsoPath)
}

async function assertDirectoryExists(path: string, message: string) {
  try {
    const info = await stat(path)

    if (!info.isDirectory()) {
      throw new Error(message)
    }
  } catch (error: unknown) {
    const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: string }).code : undefined
    if (code === "ENOENT") {
      throw new Error(message)
    }

    throw error
  }
}

async function resolveBackingFilePath(vmDiskPath: string, vmDir: string) {
  const result = runCommand(["qemu-img", "info", "--output=json", vmDiskPath], {
    errorPrefix: "qemu-img info failed",
  })
  const details = JSON.parse(result.stdout.toString()) as { "backing-filename"?: string }
  const backingFilename = details["backing-filename"]

  if (!backingFilename) {
    throw new Error(`Could not determine backing file for ${vmDiskPath}`)
  }

  return resolve(vmDir, backingFilename)
}

function validateInstanceName(value: string) {
  const instance = value.trim()

  if (!/^[a-z0-9][a-z0-9-]*$/.test(instance)) {
    throw new Error(`Invalid instance name: ${value}`)
  }

  return instance
}

function normalizeRemoteRoot(value: string) {
  const trimmed = value.trim()

  if (!trimmed.startsWith("/")) {
    throw new Error(`Remote root must be an absolute path: ${value}`)
  }

  return trimmed === "/" ? "/" : trimmed.replace(/\/+$/, "")
}

function runCommand(
  command: string[],
  options: {
    cwd?: string
    allowFailure?: boolean
    errorPrefix?: string
  } = {},
) {
  const result = Bun.spawnSync(command, {
    cwd: options.cwd,
    stderr: "pipe",
    stdout: "pipe",
  })

  if (result.exitCode !== 0 && !options.allowFailure) {
    const stderr = result.stderr.toString().trim()
    const stdout = result.stdout.toString().trim()
    throw new Error(
      [
        options.errorPrefix ?? `Command failed: ${command.join(" ")}`,
        stdout && `stdout:\n${stdout}`,
        stderr && `stderr:\n${stderr}`,
      ]
        .filter(Boolean)
        .join("\n\n"),
    )
  }

  return result
}

function createMockVmHostApiClient(target: string, dryRun: boolean): VmHostApiClient {
  return {
    async ensureVmDirectory(artifacts) {
      logMockApiCall(target, "ensureVmDirectory", {
        instance: artifacts.instance,
        remoteRoot: artifacts.remoteRoot,
      }, dryRun)
    },
    async vmExists(instance) {
      logMockApiCall(target, "vmExists", { instance }, dryRun)
      return false
    },
    async baseImageExists(baseImageName, remoteRoot) {
      logMockApiCall(target, "baseImageExists", { baseImageName, remoteRoot }, dryRun)
      return false
    },
    async uploadBaseImage(artifacts) {
      logMockApiCall(target, "uploadBaseImage", {
        instance: artifacts.instance,
        localBaseImagePath: artifacts.localBaseImagePath,
        remoteRoot: artifacts.remoteRoot,
      }, dryRun)
    },
    async uploadVmArtifacts(artifacts) {
      logMockApiCall(target, "uploadVmArtifacts", {
        instance: artifacts.instance,
        localVmDir: artifacts.localVmDir,
        localVmXmlPath: artifacts.localVmXmlPath,
        localDiskPath: artifacts.localDiskPath,
        localSeedIsoPath: artifacts.localSeedIsoPath,
      }, dryRun)
    },
    async defineAndStartVm(artifacts) {
      logMockApiCall(target, "defineAndStartVm", {
        instance: artifacts.instance,
        localVmXmlPath: artifacts.localVmXmlPath,
      }, dryRun)
    },
  }
}

function logMockApiCall(target: string, action: string, payload: Record<string, string>, dryRun: boolean) {
  const prefix = dryRun ? "[dry-run]" : "[mock-api]"
  console.log(`${prefix} ${target} ${action}`)

  for (const [key, value] of Object.entries(payload)) {
    console.log(`  ${key}: ${value}`)
  }
}

function printDryRunSummary(target: string, artifacts: DeployArtifacts) {
  console.log("Planned deploy API calls:")
  logMockApiCall(target, "ensureVmDirectory", {
    instance: artifacts.instance,
    remoteRoot: artifacts.remoteRoot,
  }, true)
  logMockApiCall(target, "vmExists", {
    instance: artifacts.instance,
  }, true)
  logMockApiCall(target, "baseImageExists", {
    baseImageName: basename(artifacts.localBaseImagePath),
    remoteRoot: artifacts.remoteRoot,
  }, true)
  logMockApiCall(target, "uploadBaseImage", {
    instance: artifacts.instance,
    localBaseImagePath: artifacts.localBaseImagePath,
    remoteRoot: artifacts.remoteRoot,
  }, true)
  logMockApiCall(target, "uploadVmArtifacts", {
    instance: artifacts.instance,
    localVmDir: artifacts.localVmDir,
    localVmXmlPath: artifacts.localVmXmlPath,
    localDiskPath: artifacts.localDiskPath,
    localSeedIsoPath: artifacts.localSeedIsoPath,
  }, true)
  logMockApiCall(target, "defineAndStartVm", {
    instance: artifacts.instance,
    localVmXmlPath: artifacts.localVmXmlPath,
  }, true)
}

async function unlinkIfPresent(path: string) {
  try {
    await unlink(path)
  } catch (error: unknown) {
    const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: string }).code : undefined
    if (code === "ENOENT") {
      return
    }

    throw error
  }
}

async function removeDirectoryIfPresent(path: string) {
  await rm(path, { recursive: true, force: true })
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
