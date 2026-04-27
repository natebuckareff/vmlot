import { readFile, writeFile } from "node:fs/promises"
import { join, relative, resolve } from "node:path"
import { DataDir } from "./data-dir"
import { generateId, type Id } from "./id"
import { LibvirtClient } from "./libvirt-client"
import { TailscaleClient } from "./tailscale-client"
import { runCommand } from "./util"
import type { CreateVmParams, VmInfo, VmMetadata, VmRequest, VmStatus } from "./vm"
import { LoadVm } from "./load-vm"

interface CreateVmOptions {
  id?: Id
  templateDir?: string
  tailscale: TailscaleClient
}

const LIBVIRT_NETWORK_NAME = "clawnet"

export class CreateVm {
  private readonly id: Id
  private readonly createdAt: number
  private status: VmStatus
  private error?: string
  private createPromise?: Promise<void>
  private readonly templateDir: string
  private readonly libvirt: LibvirtClient
  private readonly tailscale: TailscaleClient

  constructor(
    private readonly dataDir: DataDir,
    public readonly params: CreateVmParams,
    options: CreateVmOptions,
  ) {
    this.id = options.id ?? generateId()
    this.createdAt = params.createdAt ?? Date.now()
    this.status = "creating"
    this.templateDir = options.templateDir ?? resolve(import.meta.dir, "..", "templates")
    this.libvirt = new LibvirtClient()
    this.tailscale = options.tailscale
  }

  async getInfo(): Promise<VmInfo> {
    const baseImageMetadata = await this.dataDir.readImageMetadata(this.params.baseImageId)

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
      error: this.error,
    }
  }

  async start(): Promise<void> {
    if (this.createPromise) {
      return
    }

    await this.dataDir.removeVmDir(this.id)
    await this.dataDir.writeVmRequest(this.id, this.toRequest())

    this.createPromise = this.runCreate().catch((error: unknown) => {
      this.error = error instanceof Error ? error.message : String(error)
      this.status = "create-fail"
    })
  }

  async complete(): Promise<LoadVm | undefined> {
    if (this.status === "creating") {
      return undefined
    }

    if (this.status !== "running" && this.status !== "stopped") {
      return undefined
    }

    return new LoadVm(this.dataDir, this.id, { tailscale: this.tailscale })
  }

  private async runCreate(): Promise<void> {
    const baseImageMetadata = await this.dataDir.readImageMetadata(this.params.baseImageId)
    if (!baseImageMetadata) {
      throw new Error(`Base image not found: ${this.params.baseImageId}`)
    }

    const baseImagePath = await this.dataDir.getImagePath(baseImageMetadata.id)
    const vmDir = await this.dataDir.getVmDirPath(this.id)
    const templates = getTemplatePaths(this.templateDir)
    const replacements = {
      ID: this.id,
      MEMORY: String(this.params.memory),
      NAME: this.params.name,
      PUBLIC_KEY: this.params.sshPublicKey.trim(),
      TS_AUTH_KEY: this.params.tailscaleAuthKey.trim(),
      USER: this.params.user.trim(),
      VCPUS: String(this.params.vcpu),
      VM_DIR: vmDir,
    }

    await writeFile(
      await this.dataDir.getVmUserDataPath(this.id),
      renderTemplate(await readFile(templates.userDataTemplatePath, "utf8"), replacements),
    )
    await writeFile(
      await this.dataDir.getVmMetaDataPath(this.id),
      renderTemplate(await readFile(templates.metaDataTemplatePath, "utf8"), replacements),
    )
    await writeFile(
      await this.dataDir.getVmNetworkConfigPath(this.id),
      await readFile(templates.networkConfigTemplatePath, "utf8"),
    )
    await writeFile(
      await this.dataDir.getVmXmlPath(this.id),
      renderTemplate(await readFile(templates.vmXmlTemplatePath, "utf8"), replacements),
    )

    await this.createLinkedDisk(baseImagePath, vmDir)
    await this.createSeedIso(vmDir)
    await this.ensureLibvirtNetwork()
    await this.defineAndStartVm()

    const metadata: VmMetadata = {
      id: this.id,
      name: this.params.name,
      createdAt: this.createdAt,
      baseImageId: this.params.baseImageId,
      baseImageName: baseImageMetadata.name,
      memory: this.params.memory,
      vcpu: this.params.vcpu,
      user: this.params.user,
    }

    await this.dataDir.writeVmMetadata(this.id, metadata)
    await this.dataDir.removeVmRequest(this.id)
    this.status = "running"
  }

  private async createLinkedDisk(baseImagePath: string, vmDir: string): Promise<void> {
    const relativeBackingPath = relative(vmDir, baseImagePath)

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
    )
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
    )
  }

  private async defineAndStartVm(): Promise<void> {
    const existingDomain = this.libvirt.getState(this.params.name)
    if (existingDomain) {
      throw new Error(`Libvirt domain already exists: ${this.params.name}`)
    }

    const vmXmlPath = await this.dataDir.getVmXmlPath(this.id)
    this.libvirt.define(vmXmlPath)
    this.libvirt.autostart(this.params.name)
    this.libvirt.start(this.params.name)
  }

  private async ensureLibvirtNetwork(): Promise<void> {
    const networkInfo = this.libvirt.getNetworkInfo(LIBVIRT_NETWORK_NAME)

    if (!networkInfo) {
      this.libvirt.defineNetwork(join(this.templateDir, "net.xml"))
      this.libvirt.startNetwork(LIBVIRT_NETWORK_NAME)
      this.libvirt.autostartNetwork(LIBVIRT_NETWORK_NAME)
      return
    }

    if (!networkInfo.active) {
      this.libvirt.startNetwork(LIBVIRT_NETWORK_NAME)
    }

    if (!networkInfo.autostart) {
      this.libvirt.autostartNetwork(LIBVIRT_NETWORK_NAME)
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
    }
  }
}

function getTemplatePaths(templateDir: string) {
  return {
    userDataTemplatePath: join(templateDir, "user-data.yml"),
    metaDataTemplatePath: join(templateDir, "meta-data.yml"),
    networkConfigTemplatePath: join(templateDir, "network-config.yml"),
    vmXmlTemplatePath: join(templateDir, "vm.xml"),
  }
}

function renderTemplate(template: string, replacements: Record<string, string>): string {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key: string) => {
    const replacement = replacements[key]

    if (replacement === undefined) {
      throw new Error(`No replacement found for template token {{${key}}}`)
    }

    return replacement
  })
}
