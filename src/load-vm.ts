import { CreateVm } from "./create-vm";
import { DataDir } from "./data-dir";
import type { Id } from "./id";
import { LibvirtClient } from "./libvirt-client";
import type { GuestInterfaceInfo } from "./libvirt-client";
import { TailscaleClient } from "./tailscale-client";
import type { VmInfo, VmMetadata, VmRequest } from "./vm";

interface LoadVmOptions {
  tailscale: TailscaleClient;
}

export class LoadVm {
  private metadata?: VmMetadata;
  private readonly libvirt: LibvirtClient;
  private readonly tailscale: TailscaleClient;

  constructor(
    private readonly dataDir: DataDir,
    public readonly id: Id,
    options: LoadVmOptions,
  ) {
    this.libvirt = new LibvirtClient();
    this.tailscale = options.tailscale;
  }

  async getInfo(): Promise<VmInfo> {
    const metadata = await this.getMetadata();
    const diskUsageBytes = await this.dataDir.getVmDiskUsage(this.id);

    if (metadata) {
      const domainState = this.libvirt.getState(metadata.name);

      if (!domainState) {
        return {
          id: metadata.id,
          name: metadata.name,
          status: "create-fail",
          createdAt: metadata.createdAt,
          baseImageId: metadata.baseImageId,
          baseImageName: metadata.baseImageName,
          diskUsageBytes,
          memory: metadata.memory,
          vcpu: metadata.vcpu,
          user: metadata.user,
          error: `Libvirt domain not found: ${metadata.name}`,
        };
      }

      return {
        id: metadata.id,
        name: metadata.name,
        status: domainState.vmStatus,
        createdAt: metadata.createdAt,
        baseImageId: metadata.baseImageId,
        baseImageName: metadata.baseImageName,
        diskUsageBytes,
        memory: metadata.memory,
        vcpu: metadata.vcpu,
        user: metadata.user,
        address: await this.resolveAddress(metadata, domainState.vmStatus),
      };
    }

    const request = await this.getRequest();
    if (request) {
      const baseImageMetadata = await this.dataDir.readImageMetadata(
        request.baseImageId,
      );

      return {
        id: this.id,
        name: request.name,
        status: "create-interrupted",
        createdAt: request.createdAt,
        baseImageId: request.baseImageId,
        baseImageName: baseImageMetadata?.name ?? request.baseImageId,
        diskUsageBytes,
        memory: request.memory,
        vcpu: request.vcpu,
        user: request.user,
      };
    }

    return {
      id: this.id,
      name: this.id,
      status: "create-fail",
      createdAt: undefined,
      baseImageName: "",
      diskUsageBytes,
      memory: 0,
      vcpu: 0,
      error: "VM directory is incomplete",
    };
  }

  async retryCreate(): Promise<CreateVm | undefined> {
    if (await this.getMetadata()) {
      return undefined;
    }

    const request = await this.getRequest();
    if (!request) {
      return undefined;
    }

    const createVm = new CreateVm(this.dataDir, request, {
      id: this.id,
      tailscale: this.tailscale,
    });
    await createVm.start();
    return createVm;
  }

  async remove(): Promise<void> {
    const metadata = await this.getMetadata();
    const request = metadata ? undefined : await this.getRequest();
    const domainName = metadata?.name ?? request?.name;

    if (domainName) {
      const domainState = this.libvirt.getState(domainName);
      if (domainState) {
        if (domainState.vmStatus === "running") {
          this.libvirt.destroy(domainName);
        }

        this.libvirt.undefine(domainName);
      }
    }

    if (metadata) {
      await this.tailscale.deleteDevice(metadata.tailscaleDeviceId);
    }

    await this.dataDir.removeVmDir(this.id);
  }

  async start(): Promise<void> {
    const domainName = await this.getDomainName();
    if (!domainName) {
      throw new Error(`VM is missing a domain name: ${this.id}`);
    }

    const domainState = this.libvirt.getState(domainName);
    if (!domainState) {
      throw new Error(`Libvirt domain not found: ${domainName}`);
    }

    if (domainState.vmStatus === "running") {
      return;
    }

    this.libvirt.start(domainName);
  }

  async stop(): Promise<void> {
    const domainName = await this.getDomainName();
    if (!domainName) {
      throw new Error(`VM is missing a domain name: ${this.id}`);
    }

    const domainState = this.libvirt.getState(domainName);
    if (!domainState) {
      throw new Error(`Libvirt domain not found: ${domainName}`);
    }

    if (domainState.vmStatus !== "running") {
      return;
    }

    this.libvirt.destroy(domainName);
  }

  private async getMetadata(): Promise<VmMetadata | undefined> {
    if (this.metadata) {
      return this.metadata;
    }

    this.metadata = await this.dataDir.readVmMetadata(this.id);
    return this.metadata;
  }

  private getRequest(): Promise<VmRequest | undefined> {
    return this.dataDir.readVmRequest(this.id);
  }

  private async getDomainName(): Promise<string | undefined> {
    const metadata = await this.getMetadata();
    if (metadata) {
      return metadata.name;
    }

    const request = await this.getRequest();
    return request?.name;
  }

  private async resolveAddress(
    metadata: VmMetadata,
    status: VmInfo["status"],
  ): Promise<string | undefined> {
    if (status !== "running") {
      return undefined;
    }

    return this.getTailscaleAddress(metadata, metadata.name);
  }

  private async getTailscaleAddress(
    metadata: VmMetadata,
    domainName: string,
  ): Promise<string | undefined> {
    try {
      const device = await this.tailscale.findDeviceById(
        metadata.tailscaleDeviceId,
      );
      if (!device) {
        return undefined;
      }

      const apiAddress = firstIpv4(device.addresses);
      if (apiAddress) {
        return apiAddress;
      }
    } catch {
      // Fall through to guest agent inspection of tailscale0 only.
    }

    return this.getGuestTailscaleAddress(domainName);
  }

  private getGuestTailscaleAddress(domainName: string): string | undefined {
    try {
      const interfaces = this.libvirt.getGuestInterfaces(domainName);
      return firstGuestTailscaleIpv4(interfaces);
    } catch {
      return undefined;
    }
  }
}

function firstIpv4(addresses: string[] | undefined): string | undefined {
  return addresses?.find((address) => isIpv4Address(address));
}

function firstGuestTailscaleIpv4(
  interfaces: GuestInterfaceInfo[],
): string | undefined {
  const tailscaleInterface = interfaces.find(
    (guestInterface) => guestInterface.name === "tailscale0",
  );
  if (!tailscaleInterface) {
    return undefined;
  }

  return tailscaleInterface.ipAddresses
    .map((address) => address.ipAddress)
    .find((address) => isIpv4Address(address) && !address.startsWith("127."));
}

function isIpv4Address(value: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value);
}
