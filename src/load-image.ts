
export interface LoadImageParams {
  info: ImageInfo
}

export class LoadImage {
  private metadata?: ImageMetadata // initially not loaded

  constructor(private dataDir: DataDir, public readonly id: string) {}

  async getInfo(): Promise<ImageInfo> {
    // TODO:
    // if there is a .download file in the image dir, status is `download-interrupted`
    // this is signalled if getMetadata() retrurns undefined
    throw Error('todo')
  }

  async retryDownload(): Promise<CreateImage | undefined> {
    // if there is a .download file in the image dir, retry the download
    const info = await this.getInfo()
    if (info.progress != 'download-interrupted') {
      return
    }
    return new CreateImage(this.dataDir, {
      // TODO: fill in from info
    })
  }

  private async getMetadata(): Promise<ImageMetadata | undefined> {
    if (this.metadata) {
      return this.metadata
    }
    // TODO: use dataDir to read metadata
    // if a download was interrupted, there will be no metadata, so returns undefined 
    throw Error('todo')
  }
}
