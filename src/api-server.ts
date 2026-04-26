export class ApiServer implements Api {
  private isSetup: boolean
  private dataDir: DataDir
  private vms: VmInfo[]
  private images: Map<string, CreateImage | LoadImage>

  constructor() {
    this.isSetup = false
  }

  async listVms(): Promise<VmInfo[]> {
    return this.vms
  }

  async listImages(): Promise<ImageInfo[]> {
    const images = []
    for (const image of self.images.values()) {
      images.push(await image.getInfo())
    }
    images.sort((a, b) => a.name < b.name)
    return images
  }

  async createImage(params: CreateImageParams): Promise<ImageInfo> {
    const createImage = new CreateImage(this.filesystem, params)
    const info = await createImage.getInfo()
    self.images.set(info.id, createImage)
    await createImage.start()
    return info
  }

  private setup(): Promise<void> {
    // TODO: will do vms later

    for (const id of await self.dataDir.listImages()) {
      const loadImage = new LoadImage(self.dataDir, id)
      this.images.set(id, loadImage)
    }
  }
}
