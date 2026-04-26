import { createHash } from "node:crypto"
import { open, rename } from "node:fs/promises"
import { basename, extname, join } from "node:path"
import { unlinkIfPresent } from "./fs"

export class ImageDownload {
  private readonly parsedUrl: URL

  constructor(
    private readonly url: string,
    private readonly outputRootDir: string,
  ) {
    this.parsedUrl = new URL(url)
  }

  get destinationPath(): string {
    return join(this.outputRootDir, localFilenameForUrl(this.parsedUrl))
  }

  async isCached(): Promise<boolean> {
    return Bun.file(this.destinationPath).exists()
  }

  async ensureDownloaded(): Promise<string> {
    if (await this.isCached()) {
      return this.destinationPath
    }

    const tempPath = `${this.destinationPath}.download`

    console.log(`Downloading ${this.url}`)
    const response = await fetch(this.parsedUrl)

    if (!response.ok) {
      throw new Error(`Failed to download ${this.url}: ${response.status} ${response.statusText}`)
    }

    try {
      await writeResponseWithProgress(response, tempPath)
      await rename(tempPath, this.destinationPath)
    } catch (error) {
      await unlinkIfPresent(tempPath)
      throw error
    }

    return this.destinationPath
  }
}

function localFilenameForUrl(url: URL): string {
  const baseName = basename(url.pathname)

  if (baseName) {
    return baseName
  }

  const extension = extname(url.pathname) || ".qcow2"
  const digest = createHash("sha256").update(url.toString()).digest("hex").slice(0, 16)
  return `base-${digest}${extension}`
}

async function writeResponseWithProgress(response: Response, destinationPath: string): Promise<void> {
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
        renderDownloadProgress(downloadedBytes, hasKnownLength ? totalBytes : null)
        lastRenderAt = now
      }
    }

    renderDownloadProgress(downloadedBytes, hasKnownLength ? totalBytes : null)
    process.stdout.write("\n")
  } finally {
    await file.close()
  }
}

function renderDownloadProgress(downloadedBytes: number, totalBytes: number | null): void {
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

function formatBytes(bytes: number): string {
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
