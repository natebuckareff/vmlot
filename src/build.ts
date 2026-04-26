import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { join, relative } from "node:path"
import { ImageDownload } from "./download"
import { assertFileExists, removeDirectoryIfPresent } from "./fs"
import { runCommand } from "./util"

export interface VmBuildOptions {
  instance: string
  user: string
  sshPublicKey: string
  tailscaleAuthKey: string
  baseImageUrl: string
  outputRootDir: string
  templateDir: string
  remoteRoot: string
}

export interface VmArtifactPaths {
  outputDir: string
  renderedUserDataPath: string
  renderedMetaDataPath: string
  renderedNetworkConfigPath: string
  renderedVmXmlPath: string
  seedIsoPath: string
  vmDiskPath: string
}

export class VmBuild {
  readonly artifactPaths: VmArtifactPaths

  constructor(private readonly options: VmBuildOptions) {
    this.artifactPaths = getVmArtifactPaths(options.outputRootDir, options.instance)
  }

  async build(): Promise<void> {
    await assertPathDoesNotExist(
      this.artifactPaths.outputDir,
      `VM output directory already exists: ${this.artifactPaths.outputDir}`,
    )

    const templates = this.getTemplatePaths()
    await assertFileExists(templates.userDataTemplatePath)
    await assertFileExists(templates.metaDataTemplatePath)
    await assertFileExists(templates.networkConfigTemplatePath)
    await assertFileExists(templates.vmXmlTemplatePath)

    const replacements = {
      NAME: this.options.instance,
      USER: this.options.user.trim(),
      PUBLIC_KEY: this.options.sshPublicKey.trim(),
      TS_AUTH_KEY: this.options.tailscaleAuthKey.trim(),
      REMOTE_ROOT: this.options.remoteRoot,
    }

    const userData = renderTemplate(await readFile(templates.userDataTemplatePath, "utf8"), replacements)
    const metaData = renderTemplate(await readFile(templates.metaDataTemplatePath, "utf8"), replacements)
    const vmXml = renderTemplate(await readFile(templates.vmXmlTemplatePath, "utf8"), replacements)

    const baseImagePath = await this.ensureBaseImageDownloaded()
    console.log(`Using base image ${baseImagePath}`)

    await mkdir(this.artifactPaths.outputDir, { recursive: true })

    try {
      await writeFile(this.artifactPaths.renderedUserDataPath, userData)
      await writeFile(this.artifactPaths.renderedMetaDataPath, metaData)
      await writeFile(this.artifactPaths.renderedVmXmlPath, vmXml)
      await Bun.write(this.artifactPaths.renderedNetworkConfigPath, Bun.file(templates.networkConfigTemplatePath))

      console.log(`Rendering cloud-init into ${this.artifactPaths.outputDir}`)
      await this.createLinkedDisk(baseImagePath)
      this.createSeedIso()

      console.log(`Wrote ${this.artifactPaths.seedIsoPath}`)
      console.log(`Wrote ${this.artifactPaths.vmDiskPath}`)
      console.log(`Wrote ${this.artifactPaths.renderedVmXmlPath}`)
    } catch (error) {
      await removeDirectoryIfPresent(this.artifactPaths.outputDir)
      throw error
    }
  }

  async ensureBaseImageDownloaded(): Promise<string> {
    const baseImageDownload = new ImageDownload(this.options.baseImageUrl, this.options.outputRootDir)
    return baseImageDownload.ensureDownloaded()
  }

  private getTemplatePaths() {
    return {
      userDataTemplatePath: join(this.options.templateDir, "user-data.yml"),
      metaDataTemplatePath: join(this.options.templateDir, "meta-data.yml"),
      networkConfigTemplatePath: join(this.options.templateDir, "network-config.yml"),
      vmXmlTemplatePath: join(this.options.templateDir, "vm.xml"),
    }
  }

  private async createLinkedDisk(baseImagePath: string): Promise<void> {
    const relativeBackingPath = relative(this.artifactPaths.outputDir, baseImagePath)

    runCommand(["qemu-img", "create", "-f", "qcow2", "-F", "qcow2", "-b", relativeBackingPath, this.artifactPaths.vmDiskPath], {
      cwd: this.artifactPaths.outputDir,
      errorPrefix: "qemu-img create failed",
    })
  }

  private createSeedIso(): void {
    runCommand(
      [
        "cloud-localds",
        `--network-config=${this.artifactPaths.renderedNetworkConfigPath}`,
        this.artifactPaths.seedIsoPath,
        this.artifactPaths.renderedUserDataPath,
        this.artifactPaths.renderedMetaDataPath,
      ],
      {
        cwd: this.artifactPaths.outputDir,
        errorPrefix: "cloud-localds failed",
      },
    )
  }
}

export function getVmArtifactPaths(outputRootDir: string, instance: string): VmArtifactPaths {
  const outputDir = join(outputRootDir, instance)

  return {
    outputDir,
    renderedUserDataPath: join(outputDir, "user-data"),
    renderedMetaDataPath: join(outputDir, "meta-data"),
    renderedNetworkConfigPath: join(outputDir, "network-config"),
    renderedVmXmlPath: join(outputDir, "vm.xml"),
    seedIsoPath: join(outputDir, "seed.iso"),
    vmDiskPath: join(outputDir, "disk.qcow2"),
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

async function assertPathDoesNotExist(path: string, message: string): Promise<void> {
  try {
    await stat(path)
  } catch (error: unknown) {
    const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: string }).code : undefined
    if (code === "ENOENT") {
      return
    }

    throw error
  }

  throw new Error(message)
}
