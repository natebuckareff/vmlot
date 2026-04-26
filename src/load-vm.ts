import { CreateVm } from "./create-vm"
import { DataDir } from "./data-dir"
import { LibvirtClient } from "./libvirt-client"
import { VmInfo, VmMetadata, VmRequest } from "./vm"

export class LoadVm {
  private metadata?: VmMetadata
  private readonly libvirt: LibvirtClient

  constructor(
    private readonly dataDir: DataDir,
    public readonly id: string,
  ) {
    this.libvirt = new LibvirtClient()
  }

  async getInfo(): Promise<VmInfo> {
    const metadata = await this.getMetadata()
    if (metadata) {
      const domainState = this.libvirt.getState(metadata.name)

      if (!domainState) {
        return {
          id: metadata.id,
          name: metadata.name,
          status: "create-fail",
          baseImageId: metadata.baseImageId,
          baseImageName: metadata.baseImageName,
          memory: metadata.memory,
          vcpu: metadata.vcpu,
          error: `Libvirt domain not found: ${metadata.name}`,
        }
      }

      return {
        id: metadata.id,
        name: metadata.name,
        status: domainState.vmStatus,
        baseImageId: metadata.baseImageId,
        baseImageName: metadata.baseImageName,
        memory: metadata.memory,
        vcpu: metadata.vcpu,
      }
    }

    const request = await this.getRequest()
    if (request) {
      const baseImageMetadata = await this.dataDir.readImageMetadata(request.baseImageId)

      return {
        id: this.id,
        name: request.name,
        status: "create-interrupted",
        baseImageId: request.baseImageId,
        baseImageName: baseImageMetadata?.name ?? request.baseImageId,
        memory: request.memory,
        vcpu: request.vcpu,
      }
    }

    return {
      id: this.id,
      name: this.id,
      status: "create-fail",
      baseImageId: "",
      baseImageName: "",
      memory: 0,
      vcpu: 0,
      error: "VM directory is incomplete",
    }
  }

  async retryCreate(): Promise<CreateVm | undefined> {
    const info = await this.getInfo()
    if (info.status !== "create-interrupted") {
      return undefined
    }

    const request = await this.getRequest()
    if (!request) {
      return undefined
    }

    const createVm = new CreateVm(this.dataDir, request, { id: this.id })
    await createVm.start()
    return createVm
  }

  private async getMetadata(): Promise<VmMetadata | undefined> {
    if (this.metadata) {
      return this.metadata
    }

    this.metadata = await this.dataDir.readVmMetadata(this.id)
    return this.metadata
  }

  private getRequest(): Promise<VmRequest | undefined> {
    return this.dataDir.readVmRequest(this.id)
  }
}
