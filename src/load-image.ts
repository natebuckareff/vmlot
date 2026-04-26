import { stat } from "node:fs/promises"
import { CreateImage } from "./create-image"
import { DataDir } from "./data-dir"
import { ImageInfo, ImageMetadata } from "./image"

export class LoadImage {
  private metadata?: ImageMetadata

  constructor(
    private readonly dataDir: DataDir,
    public readonly id: string,
  ) {}

  async getInfo(): Promise<ImageInfo> {
    const metadata = await this.getMetadata()

    if (metadata) {
      return {
        id: metadata.id,
        name: metadata.name,
        url: metadata.url,
        status: "ready",
        hash: metadata.hash,
        sizeBytes: await this.getFileSize(await this.dataDir.getImagePath(this.id)),
        progress: 1,
      }
    }

    const request = await this.dataDir.readImageRequest(this.id)
    const hasDownload = await this.dataDir.hasImageDownload(this.id)

    if (hasDownload) {
      return {
        id: this.id,
        name: request?.name ?? this.id,
        url: request?.url ?? "",
        status: "download-interrupted",
        sizeBytes: await this.getFileSize(await this.dataDir.getImageDownloadPath(this.id)),
        progress: 0,
        error: request ? undefined : "Interrupted download is missing request.json",
      }
    }

    return {
      id: this.id,
      name: request?.name ?? this.id,
      url: request?.url ?? "",
      status: "download-fail",
      progress: 0,
      error: "Image directory is incomplete",
    }
  }

  async retryDownload(): Promise<CreateImage | undefined> {
    const info = await this.getInfo()
    if (info.status !== "download-interrupted") {
      return undefined
    }

    const request = await this.dataDir.readImageRequest(this.id)
    if (!request) {
      return undefined
    }

    const createImage = new CreateImage(this.dataDir, request, { id: this.id })
    await createImage.start()
    return createImage
  }

  private async getMetadata(): Promise<ImageMetadata | undefined> {
    if (this.metadata) {
      return this.metadata
    }

    this.metadata = await this.dataDir.readImageMetadata(this.id)
    return this.metadata
  }

  private async getFileSize(path: string): Promise<number | undefined> {
    try {
      return (await stat(path)).size
    } catch {
      return undefined
    }
  }
}
