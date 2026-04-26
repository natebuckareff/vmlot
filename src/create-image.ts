import { createHash, randomUUID } from "node:crypto"
import { open } from "node:fs/promises"
import { join } from "node:path"
import { DataDir } from "./data-dir"
import { unlinkIfPresent } from "./fs"
import { ImageInfo, ImageStatus } from "./image"
import { LoadImage } from "./load-image"

export interface CreateImageParams {
  name: string
  url: string
  createdAt?: number
}

interface CreateImageOptions {
  id?: string
}

export class CreateImage {
  private readonly id: string
  private readonly name: string
  private readonly createdAt: number
  private downloadedBytes: number
  private progress: number
  private hash?: string
  private error?: string
  private status: ImageStatus
  private downloadPromise?: Promise<void>
  private readonly abortController: AbortController
  private isCanceled: boolean

  constructor(
    private readonly dataDir: DataDir,
    public readonly params: CreateImageParams,
    options: CreateImageOptions = {},
  ) {
    this.id = options.id ?? randomUUID()
    this.name = params.name
    this.createdAt = params.createdAt ?? Date.now()
    this.downloadedBytes = 0
    this.progress = 0
    this.status = "downloading"
    this.abortController = new AbortController()
    this.isCanceled = false
  }

  async getInfo(): Promise<ImageInfo> {
    return {
      id: this.id,
      name: this.name,
      url: this.params.url,
      status: this.status,
      createdAt: this.createdAt,
      hash: this.hash,
      sizeBytes: this.downloadedBytes,
      progress: this.progress,
      error: this.error,
    }
  }

  async start(): Promise<void> {
    if (this.downloadPromise) {
      return
    }

    await this.dataDir.writeImageRequest(this.id, {
      name: this.params.name,
      url: this.params.url,
      createdAt: this.createdAt,
    })

    const downloadPath = await this.dataDir.getImageDownloadPath(this.id)
    await unlinkIfPresent(downloadPath)

    this.downloadPromise = this.runDownload(downloadPath).catch((error: unknown) => {
      if (this.isCanceled) {
        return
      }

      this.error = error instanceof Error ? error.message : String(error)
      this.status = "download-fail"
    })
  }

  async cancel(): Promise<void> {
    this.isCanceled = true
    this.abortController.abort()
    await this.downloadPromise
  }

  async complete(): Promise<LoadImage | undefined> {
    if (this.status === "downloading") {
      return undefined
    }

    if (this.status !== "ready") {
      return undefined
    }

    return new LoadImage(this.dataDir, this.id)
  }

  private async runDownload(downloadPath: string): Promise<void> {
    const response = await fetch(this.params.url, {
      signal: this.abortController.signal,
    })

    if (!response.ok) {
      throw new Error(`Failed to download ${this.params.url}: ${response.status} ${response.statusText}`)
    }

    if (!response.body) {
      throw new Error("Download response did not include a body")
    }

    const totalBytesHeader = response.headers.get("content-length")
    const totalBytes = totalBytesHeader ? Number.parseInt(totalBytesHeader, 10) : Number.NaN
    const hasKnownLength = Number.isFinite(totalBytes) && totalBytes > 0
    const file = await open(downloadPath, "w")
    const reader = response.body.getReader()
    const hasher = createHash("sha256")
    let downloadedBytes = 0

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
        hasher.update(value)
        downloadedBytes += value.byteLength
        this.downloadedBytes = downloadedBytes
        if (hasKnownLength) {
          this.progress = Math.min(downloadedBytes / totalBytes, 1)
        }
      }
    } finally {
      await file.close()
    }

    this.hash = hasher.digest("hex")
    this.downloadedBytes = downloadedBytes
    this.progress = 1
    await this.dataDir.completeImageDownload(this.id)
    await this.dataDir.writeImageMetadata(this.id, {
      id: this.id,
      name: this.name,
      url: this.params.url,
      createdAt: this.createdAt,
      hash: this.hash,
    })
    await this.dataDir.removeImageRequest(this.id)
    this.status = "ready"
  }
}
