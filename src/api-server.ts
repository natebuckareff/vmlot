import type { Api } from "./api"
import { CreateImage, type CreateImageParams } from "./create-image"
import { CreateVm } from "./create-vm"
import { DataDir } from "./data-dir"
import type { Id } from "./id"
import { IdMap } from "./id-map"
import type { ImageInfo } from "./image"
import { LoadImage } from "./load-image"
import { LoadVm } from "./load-vm"
import { TailscaleClient } from "./tailscale-client"
import { DEFAULT_VM_USER, type CreateVmInput, type CreateVmParams, type VmInfo } from "./vm"

interface ApiServerOptions {
  dataDir: DataDir
  tailscale: TailscaleClient
}

export class ApiServer implements Api {
  private isSetup: boolean
  private readonly dataDir: DataDir
  private readonly tailscale: TailscaleClient
  private readonly vms: IdMap<CreateVm | LoadVm>
  private readonly images: IdMap<CreateImage | LoadImage>

  constructor(options: ApiServerOptions) {
    this.isSetup = false
    this.dataDir = options.dataDir
    this.tailscale = options.tailscale
    this.vms = new IdMap("VM")
    this.images = new IdMap("Image")
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
    await this.validateCreateImageParams(params)

    const createImage = new CreateImage(this.dataDir, params)
    const info = await createImage.getInfo()
    this.images.set(info.id, createImage)
    await createImage.start()
    return createImage.getInfo()
  }

  async removeImage(id: string): Promise<void> {
    await this.setup()
    const resolvedId = this.images.resolve(id)
    const image = this.requireImage(resolvedId)

    const info = await image.getInfo()
    if (info.status === "downloading") {
      if (!(image instanceof CreateImage)) {
        throw new Error(`Image is marked downloading but is not an active CreateImage job: ${info.name}`)
      }

      await image.cancel()
    }

    const linkedVms = (await this.listVms()).filter((vm) => vm.baseImageId === resolvedId)
    if (linkedVms.length > 0) {
      throw new Error(`Cannot remove image while VMs reference it: ${linkedVms.map((vm) => vm.name).join(", ")}`)
    }

    await this.dataDir.removeImageDir(resolvedId)
    this.images.delete(id)
  }

  async createVm(input: CreateVmInput): Promise<VmInfo> {
    await this.setup()
    const normalizedInput = await this.normalizeCreateVmInput(input)
    const params = await this.resolveCreateVmParams(normalizedInput)
    await this.validateCreateVmParams(params)

    const createVm = new CreateVm(this.dataDir, params, { tailscale: this.tailscale })
    const info = await createVm.getInfo()
    this.vms.set(info.id, createVm)
    await createVm.start()
    return createVm.getInfo()
  }

  async startVm(id: string): Promise<void> {
    const loadVm = await this.requireLoadedVm(this.vms.resolve(id))
    await loadVm.start()
  }

  async stopVm(id: string): Promise<void> {
    const loadVm = await this.requireLoadedVm(this.vms.resolve(id))
    await loadVm.stop()
  }

  async removeVm(id: string): Promise<void> {
    await this.setup()
    const resolvedId = this.vms.resolve(id)
    const loadVm = await this.requireLoadedVm(resolvedId)
    await loadVm.remove()
    this.vms.delete(resolvedId)
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
  }

  private async validateCreateImageParams(params: CreateImageParams): Promise<void> {
    if (params.name.trim().length === 0) {
      throw new Error("Image name is required")
    }

    const existingImage = (await this.listImages()).find((image) => image.name === params.name)
    if (existingImage) {
      throw new Error(`Image name already exists: ${params.name}`)
    }
  }

  private async normalizeCreateVmInput(
    input: CreateVmInput,
  ): Promise<Omit<CreateVmInput, "user" | "baseImageId"> & { user: string; baseImageId: Id }> {
    const normalizedInput: Omit<CreateVmInput, "user"> & { user: string } = {
      ...input,
      user: input.user?.trim() || DEFAULT_VM_USER,
    }

    await this.validateCreateVmInput(normalizedInput)
    const baseImage = await this.resolveBaseImage(input.baseImageId)

    return {
      ...normalizedInput,
      baseImageId: baseImage.id,
    }
  }

  private async resolveCreateVmParams(
    input: Omit<CreateVmInput, "user" | "baseImageId"> & { user: string; baseImageId: Id },
  ): Promise<CreateVmParams> {
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

  private async validateCreateVmParams(params: CreateVmParams): Promise<void> {
    const baseImage = this.requireImage(params.baseImageId)
    const info = await baseImage.getInfo()

    if (info.status !== "ready") {
      throw new Error(`Base image is not ready: ${info.name} (${info.status})`)
    }
  }

  private async requireLoadedVm(id: Id): Promise<LoadVm> {
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

  private requireImage(id: Id): CreateImage | LoadImage {
    const image = this.images.get(id)
    if (!image) {
      throw new Error(`Image not found: ${id}`)
    }

    return image
  }

  private async resolveBaseImage(value: string): Promise<ImageInfo> {
    const images = await this.listImages()

    const nameMatches = images.filter((image) => image.name === value)
    if (nameMatches.length === 1) {
      const [match] = nameMatches
      if (!match) {
        throw new Error(`Base image not found: ${value}`)
      }
      return match
    }

    if (nameMatches.length > 1) {
      const readyMatches = nameMatches.filter((image) => image.status === "ready")
      if (readyMatches.length === 1) {
        const [match] = readyMatches
        if (!match) {
          throw new Error(`Base image not found: ${value}`)
        }
        return match
      }

      throw new Error(`Base image name must resolve to one ready image: ${value}`)
    }

    const resolvedId = this.images.resolve(value)
    const match = images.find((image) => image.id === resolvedId)
    if (!match) {
      throw new Error(`Base image not found: ${value}`)
    }

    return match
  }
}
