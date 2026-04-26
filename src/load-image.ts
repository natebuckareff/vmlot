
export interface LoadImageParams {
  info: ImageInfo
}

export class LoadImage {
  private metadata?: ImageMetadata // initially not loaded

  constructor(private dataDir: DataDir, public readonly id: string) {}

  async getInfo(): Promise<ImageInfo> {
    // TODO: returns info with download related properties set to completed states
    // derived from metadata
    throw Error('todo')
  }

  private async getMetadata(): Promise<ImageMetadata> {
    if (this.metadata) {
      return this.metadata
    }
    // TODO: use dataDir to read metadata
    throw Error('todo')
  }
}
