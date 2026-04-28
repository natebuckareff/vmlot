import { writeFile } from "node:fs/promises";
import { relative } from "node:path";
import { DataDir } from "./data-dir";
import { generateId, type Id } from "./id";
import { LibvirtClient } from "./libvirt-client";
import { TailscaleClient } from "./tailscale-client";
import { runCommand } from "./util";
import metaDataTemplate from "../templates/meta-data.yml" with { type: "text" };
import netTemplate from "../templates/net.xml" with { type: "text" };
import networkConfigTemplate from "../templates/network-config.yml" with { type: "text" };
import userDataTemplate from "../templates/user-data.yml" with { type: "text" };
import vmXmlTemplate from "../templates/vm.xml" with { type: "text" };
import {
  getVmHostname,
  isVmCreateInProgress,
  type CreateVmParams,
  type VmInfo,
  type VmMetadata,
  type VmRequest,
  type VmStatus,
} from "./vm";
import { LoadVm } from "./load-vm";

interface CreateVmOptions {
  id?: Id;
  tailscale: TailscaleClient;
}

const LIBVIRT_NETWORK_NAME = "vmlotnet";

export class CreateVm {
  private readonly id: Id;
  private readonly createdAt: number;
  private status: VmStatus;
  private error?: string;
  private createPromise?: Promise<void>;
  private readonly libvirt: LibvirtClient;
  private readonly tailscale: TailscaleClient;

  constructor(
    private readonly dataDir: DataDir,
    public readonly params: CreateVmParams,
    options: CreateVmOptions,
  ) {
    this.id = options.id ?? generateId();
    this.createdAt = params.createdAt ?? Date.now();
    this.status = "preparing";
    this.libvirt = new LibvirtClient();
    this.tailscale = options.tailscale;
  }

  async getInfo(): Promise<VmInfo> {
    const baseImageMetadata = await this.dataDir.readImageMetadata(
      this.params.baseImageId,
    );

    return {
      id: this.id,
      name: this.params.name,
      status: this.status,
      createdAt: this.createdAt,
      baseImageId: this.params.baseImageId,
      baseImageName: baseImageMetadata?.name ?? this.params.baseImageId,
      diskUsageBytes: await this.dataDir.getVmDiskUsage(this.id),
      memory: this.params.memory,
      vcpu: this.params.vcpu,
      user: this.params.user,
      error: this.error,
    };
  }

  async start(): Promise<void> {
    if (this.createPromise) {
      return;
    }

    await this.dataDir.removeVmDir(this.id);
    await this.dataDir.writeVmRequest(this.id, this.toRequest());

    this.createPromise = this.runCreate().catch((error: unknown) => {
      this.error = error instanceof Error ? error.message : String(error);
      this.status = "create-fail";
    });
  }

  async complete(): Promise<LoadVm | undefined> {
    if (isVmCreateInProgress(this.status)) {
      return undefined;
    }

    if (this.status !== "running" && this.status !== "stopped") {
      return undefined;
    }

    return new LoadVm(this.dataDir, this.id, { tailscale: this.tailscale });
  }

  private async runCreate(): Promise<void> {
    const baseImageMetadata = await this.dataDir.readImageMetadata(
      this.params.baseImageId,
    );
    if (!baseImageMetadata) {
      throw new Error(`Base image not found: ${this.params.baseImageId}`);
    }

    const baseImagePath = await this.dataDir.getImagePath(baseImageMetadata.id);
    const vmDir = await this.dataDir.getVmDirPath(this.id);
    const hostname = getVmHostname(this.params.name, this.id);
    const replacements = {
      HOSTNAME: hostname,
      ID: this.id,
      MEMORY: String(this.params.memory),
      NAME: this.params.name,
      PUBLIC_KEY: this.params.sshPublicKey.trim(),
      TS_AUTH_KEY: this.params.tailscaleAuthKey.trim(),
      USER: this.params.user.trim(),
      VCPUS: String(this.params.vcpu),
      VM_DIR: vmDir,
    };

    await writeFile(
      await this.dataDir.getVmUserDataPath(this.id),
      renderTemplate(userDataTemplate, replacements),
    );
    await writeFile(
      await this.dataDir.getVmMetaDataPath(this.id),
      renderTemplate(metaDataTemplate, replacements),
    );
    await writeFile(
      await this.dataDir.getVmNetworkConfigPath(this.id),
      networkConfigTemplate,
    );
    await writeFile(
      await this.dataDir.getVmXmlPath(this.id),
      renderTemplate(vmXmlTemplate, replacements),
    );

    await this.createLinkedDisk(baseImagePath, vmDir);
    await this.createSeedIso(vmDir);

    this.status = "creating";
    await this.ensureLibvirtNetwork();
    await this.defineAndStartVm();

    this.status = "connecting";
    const tailscaleDeviceId = (
      await this.tailscale.waitForDeviceByHostname(hostname)
    ).id;

    const metadata: VmMetadata = {
      id: this.id,
      name: this.params.name,
      createdAt: this.createdAt,
      baseImageId: this.params.baseImageId,
      baseImageName: baseImageMetadata.name,
      memory: this.params.memory,
      vcpu: this.params.vcpu,
      user: this.params.user,
      tailscaleDeviceId,
    };

    await this.dataDir.writeVmMetadata(this.id, metadata);
    await this.dataDir.removeVmRequest(this.id);
    this.status = "running";
  }

  private async createLinkedDisk(
    baseImagePath: string,
    vmDir: string,
  ): Promise<void> {
    const relativeBackingPath = relative(vmDir, baseImagePath);

    runCommand(
      [
        "qemu-img",
        "create",
        "-f",
        "qcow2",
        "-F",
        "qcow2",
        "-b",
        relativeBackingPath,
        await this.dataDir.getVmDiskPath(this.id),
      ],
      {
        cwd: vmDir,
        errorPrefix: "qemu-img create failed",
      },
    );
  }

  private async createSeedIso(vmDir: string): Promise<void> {
    runCommand(
      [
        "cloud-localds",
        `--network-config=${await this.dataDir.getVmNetworkConfigPath(this.id)}`,
        await this.dataDir.getVmSeedIsoPath(this.id),
        await this.dataDir.getVmUserDataPath(this.id),
        await this.dataDir.getVmMetaDataPath(this.id),
      ],
      {
        cwd: vmDir,
        errorPrefix: "cloud-localds failed",
      },
    );
  }

  private async defineAndStartVm(): Promise<void> {
    const existingDomain = this.libvirt.getState(this.params.name);
    if (existingDomain) {
      throw new Error(`Libvirt domain already exists: ${this.params.name}`);
    }

    const vmXmlPath = await this.dataDir.getVmXmlPath(this.id);
    this.libvirt.define(vmXmlPath);
    this.libvirt.autostart(this.params.name);
    this.libvirt.start(this.params.name);
  }

  private async ensureLibvirtNetwork(): Promise<void> {
    const networkInfo = this.libvirt.getNetworkInfo(LIBVIRT_NETWORK_NAME);

    if (!networkInfo) {
      const networkXmlPath = await this.dataDir.getLibvirtNetworkXmlPath();
      await writeFile(networkXmlPath, netTemplate);
      this.libvirt.defineNetwork(networkXmlPath);
      this.libvirt.startNetwork(LIBVIRT_NETWORK_NAME);
      this.libvirt.autostartNetwork(LIBVIRT_NETWORK_NAME);
      return;
    }

    if (!networkInfo.active) {
      this.libvirt.startNetwork(LIBVIRT_NETWORK_NAME);
    }

    if (!networkInfo.autostart) {
      this.libvirt.autostartNetwork(LIBVIRT_NETWORK_NAME);
    }
  }
  private toRequest(): VmRequest {
    return {
      name: this.params.name,
      createdAt: this.createdAt,
      baseImageId: this.params.baseImageId,
      user: this.params.user,
      sshPublicKey: this.params.sshPublicKey,
      tailscaleAuthKey: this.params.tailscaleAuthKey,
      memory: this.params.memory,
      vcpu: this.params.vcpu,
    };
  }
}

function renderTemplate(
  template: string,
  replacements: Record<string, string>,
): string {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key: string) => {
    const replacement = replacements[key];

    if (replacement === undefined) {
      throw new Error(`No replacement found for template token {{${key}}}`);
    }

    return replacement;
  });
}
