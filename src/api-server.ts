import { Api } from "./api"
import { CreateImage, CreateImageParams } from "./create-image"
import { CreateVm } from "./create-vm"
import { DataDir } from "./data-dir"
import { ImageInfo } from "./image"
import { LoadImage } from "./load-image"
import { LoadVm } from "./load-vm"
import { CreateVmParams, VmInfo } from "./vm"

export class ApiServer implements Api {
  private isSetup: boolean
  private readonly dataDir: DataDir
  private readonly vms: Map<string, CreateVm | LoadVm>
  private readonly images: Map<string, CreateImage | LoadImage>

  constructor(dataDirPath = "data") {
    this.isSetup = false
    this.dataDir = new DataDir(dataDirPath)
    this.vms = new Map()
    this.images = new Map()
  }

  async listVms(): Promise<VmInfo[]> {
    await this.setup()

    const vms: VmInfo[] = []
    for (const [id, vm] of this.vms.entries()) {
      const completed = vm instanceof CreateVm ? await vm.complete() : undefined
      const resolvedVm = completed ?? vm
      if (completed) {
        this.vms.set(id, completed)
      }
      vms.push(await resolvedVm.getInfo())
    }

    vms.sort((a, b) => a.name.localeCompare(b.name))
    return vms
  }

  async listImages(): Promise<ImageInfo[]> {
    await this.setup()

    const images: ImageInfo[] = []
    for (const [id, image] of this.images.entries()) {
      const completed = image instanceof CreateImage ? await image.complete() : undefined
      const resolvedImage = completed ?? image
      if (completed) {
        this.images.set(id, completed)
      }
      images.push(await resolvedImage.getInfo())
    }

    images.sort((a, b) => a.name.localeCompare(b.name))
    return images
  }

  async createImage(params: CreateImageParams): Promise<ImageInfo> {
    await this.setup()

    const createImage = new CreateImage(this.dataDir, params)
    const info = await createImage.getInfo()
    this.images.set(info.id, createImage)
    await createImage.start()
    return createImage.getInfo()
  }

  async createVm(params: CreateVmParams): Promise<VmInfo> {
    await this.setup()
    await this.validateCreateVm(params)

    const createVm = new CreateVm(this.dataDir, params)
    const info = await createVm.getInfo()
    this.vms.set(info.id, createVm)
    await createVm.start()
    return createVm.getInfo()
  }

  async removeVm(id: string): Promise<void> {
    await this.setup()

    const vm = this.vms.get(id)
    if (!vm) {
      throw new Error(`VM not found: ${id}`)
    }

    const info = await vm.getInfo()
    if (info.status === "creating") {
      throw new Error(`Cannot remove VM while creation is in progress: ${info.name}`)
    }

    const loadVm = new LoadVm(this.dataDir, id)
    await loadVm.remove()
    this.vms.delete(id)
  }

  private async setup(): Promise<void> {
    if (this.isSetup) {
      return
    }

    for (const id of await this.dataDir.listImages()) {
      const loadImage = new LoadImage(this.dataDir, id)
      const activeImage = await loadImage.retryDownload()
      this.images.set(id, activeImage ?? loadImage)
    }

    for (const id of await this.dataDir.listVms()) {
      const loadVm = new LoadVm(this.dataDir, id)
      const activeVm = await loadVm.retryCreate()
      this.vms.set(id, activeVm ?? loadVm)
    }

    this.isSetup = true
  }

  private async validateCreateVm(params: CreateVmParams): Promise<void> {
    if (params.name.trim().length === 0) {
      throw new Error("VM name is required")
    }

    if (params.user.trim().length === 0) {
      throw new Error("VM user is required")
    }

    if (params.sshPublicKey.trim().length === 0) {
      throw new Error("VM sshPublicKey is required")
    }

    if (params.tailscaleAuthKey.trim().length === 0) {
      throw new Error("VM tailscaleAuthKey is required")
    }

    if (!Number.isInteger(params.memory) || params.memory <= 0) {
      throw new Error(`Invalid VM memory: ${params.memory}`)
    }

    if (!Number.isInteger(params.vcpu) || params.vcpu <= 0) {
      throw new Error(`Invalid VM vcpu: ${params.vcpu}`)
    }

    const existingVm = (await this.listVms()).find((vm) => vm.name === params.name)
    if (existingVm) {
      throw new Error(`VM name already exists: ${params.name}`)
    }

    const baseImage = (await this.listImages()).find((image) => image.id === params.baseImageId)
    if (!baseImage) {
      throw new Error(`Base image not found: ${params.baseImageId}`)
    }

    if (baseImage.status !== "ready") {
      throw new Error(`Base image is not ready: ${baseImage.name} (${baseImage.status})`)
    }
  }
}
