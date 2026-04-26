import { CreateVm } from "./create-vm"
import { DataDir } from "./data-dir"
import { GuestInterfaceInfo, LibvirtClient } from "./libvirt-client"
import { TailscaleClient, TailscaleDevice } from "./tailscale-client"
import { VmInfo, VmMetadata, VmRequest } from "./vm"

interface LoadVmOptions {
  tailscale: TailscaleClient
}

export class LoadVm {
  private metadata?: VmMetadata
  private readonly libvirt: LibvirtClient
  private readonly tailscale: TailscaleClient

  constructor(
    private readonly dataDir: DataDir,
    public readonly id: string,
    options: LoadVmOptions,
  ) {
    this.libvirt = new LibvirtClient()
    this.tailscale = options.tailscale
  }

  async getInfo(): Promise<VmInfo> {
    const metadata = await this.getMetadata()
    if (metadata) {
      await this.maybePopulateTailscaleDeviceId(metadata)
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
        address: await this.resolveAddress(metadata, domainState.vmStatus),
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

    const createVm = new CreateVm(this.dataDir, request, { id: this.id, tailscale: this.tailscale })
    await createVm.start()
    return createVm
  }

  async remove(): Promise<void> {
    const metadata = await this.getMetadata()
    const request = metadata ? undefined : await this.getRequest()
    const domainName = metadata?.name ?? request?.name

    if (domainName) {
      const domainState = this.libvirt.getState(domainName)
      if (domainState) {
        if (domainState.vmStatus === "running") {
          this.libvirt.destroy(domainName)
        }

        this.libvirt.undefine(domainName)
      }
    }

    await this.dataDir.removeVmDir(this.id)
  }

  async start(): Promise<void> {
    const domainName = await this.getDomainName()
    if (!domainName) {
      throw new Error(`VM is missing a domain name: ${this.id}`)
    }

    const domainState = this.libvirt.getState(domainName)
    if (!domainState) {
      throw new Error(`Libvirt domain not found: ${domainName}`)
    }

    if (domainState.vmStatus === "running") {
      return
    }

    this.libvirt.start(domainName)
  }

  async stop(): Promise<void> {
    const domainName = await this.getDomainName()
    if (!domainName) {
      throw new Error(`VM is missing a domain name: ${this.id}`)
    }

    const domainState = this.libvirt.getState(domainName)
    if (!domainState) {
      throw new Error(`Libvirt domain not found: ${domainName}`)
    }

    if (domainState.vmStatus !== "running") {
      return
    }

    this.libvirt.destroy(domainName)
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

  private async getDomainName(): Promise<string | undefined> {
    const metadata = await this.getMetadata()
    if (metadata) {
      return metadata.name
    }

    const request = await this.getRequest()
    return request?.name
  }

  private async maybePopulateTailscaleDeviceId(metadata: VmMetadata): Promise<void> {
    if (metadata.tailscaleDeviceId) {
      return
    }

    try {
      const device = await this.tailscale.findDeviceByHostname(metadata.name)
      if (!device) {
        return
      }

      metadata.tailscaleDeviceId = device.id
      await this.dataDir.writeVmMetadata(this.id, metadata)
      this.metadata = metadata
    } catch {
      // Device lookup is best-effort so VM reads are not blocked on Tailscale API access.
    }
  }

  private async resolveAddress(metadata: VmMetadata, status: VmInfo["status"]): Promise<string | undefined> {
    if (status !== "running") {
      return undefined
    }

    const tailscaleAddress = await this.getTailscaleAddress(metadata)
    if (tailscaleAddress) {
      return tailscaleAddress
    }

    return this.getGuestAddress(metadata.name)
  }

  private async getTailscaleAddress(metadata: VmMetadata): Promise<string | undefined> {
    try {
      let device: TailscaleDevice | undefined

      if (metadata.tailscaleDeviceId) {
        device = await this.tailscale.findDeviceById(metadata.tailscaleDeviceId)
      }

      if (!device) {
        device = await this.tailscale.findDeviceByHostname(metadata.name)
      }

      if (!device) {
        return undefined
      }

      if (device.id !== metadata.tailscaleDeviceId) {
        metadata.tailscaleDeviceId = device.id
        await this.dataDir.writeVmMetadata(this.id, metadata)
        this.metadata = metadata
      }

      return firstIpv4(device.addresses)
    } catch {
      return undefined
    }
  }

  private getGuestAddress(domainName: string): string | undefined {
    try {
      const interfaces = this.libvirt.getGuestInterfaces(domainName)
      return firstGuestIpv4(interfaces)
    } catch {
      return undefined
    }
  }
}

function firstIpv4(addresses: string[] | undefined): string | undefined {
  return addresses?.find((address) => isIpv4Address(address))
}

function firstGuestIpv4(interfaces: GuestInterfaceInfo[]): string | undefined {
  for (const guestInterface of interfaces) {
    const ipv4Address = guestInterface.ipAddresses
      .map((address) => address.ipAddress)
      .find((address) => isIpv4Address(address) && !address.startsWith("127."))

    if (ipv4Address) {
      return ipv4Address
    }
  }

  return undefined
}

function isIpv4Address(value: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)
}
