import { createHash } from "node:crypto"
import { cp, mkdir, open, readFile, stat, writeFile } from "node:fs/promises"
import { basename, extname, join, resolve } from "node:path"

type Args = {
  instance: string
  user: string
  sshPublicKey: string
  tailscaleAuthKey: string
  baseImageUrl: string
  outputDir: string
  templateDir: string
}

async function main() {
  const args = await parseArgs(Bun.argv.slice(2))
  const instance = args.instance.trim()
  const templateDir = resolve(args.templateDir)
  const outputRootDir = resolve(args.outputDir)
  const outputDir = join(outputRootDir, instance)

  const renderedUserDataPath = join(outputDir, "user-data")
  const renderedMetaDataPath = join(outputDir, "meta-data")
  const renderedNetworkConfigPath = join(outputDir, "network-config")
  const renderedVmXmlPath = join(outputDir, "vm.xml")
  const seedIsoPath = join(outputDir, "seed.iso")
  const vmDiskPath = join(outputDir, "disk.qcow2")

  await assertPathDoesNotExist(outputDir, `VM output directory already exists: ${outputDir}`)
  await mkdir(outputDir, { recursive: true })

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
  }

  const userData = renderTemplate(await readFile(userDataTemplatePath, "utf8"), replacements)
  const metaData = renderTemplate(await readFile(metaDataTemplatePath, "utf8"), replacements)
  const vmXml = renderTemplate(await readFile(vmXmlTemplatePath, "utf8"), replacements)

  await writeFile(renderedUserDataPath, userData)
  await writeFile(renderedMetaDataPath, metaData)
  await writeFile(renderedVmXmlPath, vmXml)
  await cp(networkConfigTemplatePath, renderedNetworkConfigPath)

  console.log(`Rendering cloud-init into ${outputDir}`)
  const baseImagePath = await downloadBaseImage(args.baseImageUrl, outputRootDir)
  console.log(`Using base image ${baseImagePath}`)
  await createLinkedDisk(baseImagePath, vmDiskPath, outputDir)

  const result = Bun.spawnSync(
    [
      "cloud-localds",
      `--network-config=${renderedNetworkConfigPath}`,
      seedIsoPath,
      renderedUserDataPath,
      renderedMetaDataPath,
    ],
    {
      cwd: outputDir,
      stderr: "pipe",
      stdout: "pipe",
    },
  )

  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString().trim()
    const stdout = result.stdout.toString().trim()
    throw new Error(
      [
        "cloud-localds failed",
        stdout && `stdout:\n${stdout}`,
        stderr && `stderr:\n${stderr}`,
      ]
        .filter(Boolean)
        .join("\n\n"),
    )
  }

  console.log(`Wrote ${seedIsoPath}`)
  console.log(`Wrote ${vmDiskPath}`)
  console.log(`Wrote ${renderedVmXmlPath}`)
}

async function parseArgs(argv: string[]): Promise<Args> {
  const values = new Map<string, string>()

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]

    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`)
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

  const instance = required(values, "--instance")
  const user = required(values, "--user")
  const sshPublicKey = await resolveValue(required(values, "--ssh-public-key"))
  const tailscaleAuthKey = required(values, "--tailscale-auth-key")
  const baseImageUrl = required(values, "--base-image-url")
  const outputDir = values.get("--output-dir") ?? "build"
  const templateDir = values.get("--template-dir") ?? "templates"

  return {
    instance,
    user,
    baseImageUrl,
    outputDir,
    sshPublicKey,
    tailscaleAuthKey,
    templateDir,
  }
}

function required(values: Map<string, string>, flag: string): string {
  const value = values.get(flag)

  if (!value) {
    throw new Error(
      `Missing required ${flag}\n\n` +
        "Usage: bun run cloud.ts --instance vm01 --user debian --ssh-public-key ~/.ssh/id_ed25519.pub --tailscale-auth-key tskey-... --base-image-url https://...",
    )
  }

  return value
}

async function resolveValue(value: string): Promise<string> {
  const explicitPath = value.startsWith("@") ? value.slice(1) : null
  const candidatePath = explicitPath ?? value

  if (explicitPath || looksLikeFilePath(candidatePath)) {
    const path = resolve(candidatePath)
    return (await readFile(path, "utf8")).trim()
  }

  return value
}

async function assertFileExists(path: string) {
  try {
    await Bun.file(path).text()
  } catch {
    throw new Error(`Required file not found: ${path}`)
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

  console.log(`Downloading ${url}`)
  const response = await fetch(parsedUrl)

  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`)
  }

  await writeResponseWithProgress(response, destinationPath)
  return destinationPath
}

async function createLinkedDisk(baseImagePath: string, vmDiskPath: string, vmDir: string) {
  const relativeBackingPath = `../${basename(baseImagePath)}`
  const result = Bun.spawnSync(
    ["qemu-img", "create", "-f", "qcow2", "-F", "qcow2", "-b", relativeBackingPath, vmDiskPath],
    {
      cwd: vmDir,
      stderr: "pipe",
      stdout: "pipe",
    },
  )

  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString().trim()
    const stdout = result.stdout.toString().trim()
    throw new Error(
      [
        "qemu-img create failed",
        stdout && `stdout:\n${stdout}`,
        stderr && `stderr:\n${stderr}`,
      ]
        .filter(Boolean)
        .join("\n\n"),
    )
  }
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

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
