import { Api } from "./api"
import { CreateImage, CreateImageParams } from "./create-image"
import { CreateVm } from "./create-vm"
import { DataDir } from "./data-dir"
import { ImageInfo } from "./image"
import { LoadImage } from "./load-image"
import { LoadVm } from "./load-vm"
import { TailscaleClient } from "./tailscale-client"
import { CreateVmInput, CreateVmParams, VmInfo } from "./vm"

interface ApiServerOptions {
  dataDir: DataDir
  tailscale: TailscaleClient
}

export class ApiServer implements Api {
  private isSetup: boolean
  private readonly dataDir: DataDir
  private readonly tailscale: TailscaleClient
  private readonly vms: Map<string, CreateVm | LoadVm>
  private readonly images: Map<string, CreateImage | LoadImage>

  constructor(options: ApiServerOptions) {
    this.isSetup = false
    this.dataDir = options.dataDir
    this.tailscale = options.tailscale
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

  async removeImage(id: string): Promise<void> {
    await this.setup()

    const image = this.images.get(id)
    if (!image) {
      throw new Error(`Image not found: ${id}`)
    }

    const info = await image.getInfo()
    if (info.status === "downloading") {
      if (!(image instanceof CreateImage)) {
        throw new Error(`Image is marked downloading but is not an active CreateImage job: ${info.name}`)
      }

      await image.cancel()
    }

    const linkedVms = (await this.listVms()).filter((vm) => vm.baseImageId === id)
    if (linkedVms.length > 0) {
      throw new Error(`Cannot remove image while VMs reference it: ${linkedVms.map((vm) => vm.name).join(", ")}`)
    }

    await this.dataDir.removeImageDir(id)
    this.images.delete(id)
  }

  async createVm(input: CreateVmInput): Promise<VmInfo> {
    await this.setup()
    await this.validateCreateVmInput(input)
    const params = await this.resolveCreateVmParams(input)

    const createVm = new CreateVm(this.dataDir, params, { tailscale: this.tailscale })
    const info = await createVm.getInfo()
    this.vms.set(info.id, createVm)
    await createVm.start()
    return createVm.getInfo()
  }

  async startVm(id: string): Promise<void> {
    const loadVm = await this.requireLoadedVm(id)
    await loadVm.start()
  }

  async stopVm(id: string): Promise<void> {
    const loadVm = await this.requireLoadedVm(id)
    await loadVm.stop()
  }

  async removeVm(id: string): Promise<void> {
    await this.setup()

    const loadVm = await this.requireLoadedVm(id)
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
      const loadVm = new LoadVm(this.dataDir, id, { tailscale: this.tailscale })
      const activeVm = await loadVm.retryCreate()
      this.vms.set(id, activeVm ?? loadVm)
    }

    this.isSetup = true
  }

  private async validateCreateVmInput(input: CreateVmInput): Promise<void> {
    if (input.name.trim().length === 0) {
      throw new Error("VM name is required")
    }

    if (input.user.trim().length === 0) {
      throw new Error("VM user is required")
    }

    if (input.sshPublicKey.trim().length === 0) {
      throw new Error("VM sshPublicKey is required")
    }

    if (!Number.isInteger(input.memory) || input.memory <= 0) {
      throw new Error(`Invalid VM memory: ${input.memory}`)
    }

    if (!Number.isInteger(input.vcpu) || input.vcpu <= 0) {
      throw new Error(`Invalid VM vcpu: ${input.vcpu}`)
    }

    const existingVm = (await this.listVms()).find((vm) => vm.name === input.name)
    if (existingVm) {
      throw new Error(`VM name already exists: ${input.name}`)
    }

    const baseImage = (await this.listImages()).find((image) => image.id === input.baseImageId)
    if (!baseImage) {
      throw new Error(`Base image not found: ${input.baseImageId}`)
    }

    if (baseImage.status !== "ready") {
      throw new Error(`Base image is not ready: ${baseImage.name} (${baseImage.status})`)
    }
  }

  private async resolveCreateVmParams(input: CreateVmInput): Promise<CreateVmParams> {
    const authKey = await this.tailscale.createAuthKey(`clawthing VM ${input.name}`)

    return {
      name: input.name,
      baseImageId: input.baseImageId,
      user: input.user,
      sshPublicKey: input.sshPublicKey,
      tailscaleAuthKey: authKey.key,
      memory: input.memory,
      vcpu: input.vcpu,
    }
  }

  private async requireLoadedVm(id: string): Promise<LoadVm> {
    await this.setup()

    const vm = this.vms.get(id)
    if (!vm) {
      throw new Error(`VM not found: ${id}`)
    }

    const info = await vm.getInfo()
    if (info.status === "creating") {
      throw new Error(`Cannot operate on VM while creation is in progress: ${info.name}`)
    }

    const loadVm = new LoadVm(this.dataDir, id, { tailscale: this.tailscale })
    this.vms.set(id, loadVm)
    return loadVm
  }
}
