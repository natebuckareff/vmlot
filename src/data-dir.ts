import { mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises"
import { join, relative, resolve } from "node:path"
import { ImageMetadata, ImageRequest } from "./image"
import { VmMetadata, VmRequest } from "./vm"

/*
data directory structure:

$DATA_DIR/images/{id}/request.json          # create-image request for active/interrupted downloads
$DATA_DIR/images/{id}/meta.json             # metadata for the completed image
$DATA_DIR/images/{id}/image.qcow2           # downloaded base disk image
$DATA_DIR/images/{id}/image.qcow2.download  # downloaded base disk image
$DATA_DIR/vms/{id}/request.json             # create-vm request for active/interrupted builds
$DATA_DIR/vms/{id}/meta.json                # metadata for the completed vm
$DATA_DIR/vms/{id}/vm.xml                   # libvirt config file
$DATA_DIR/vms/{id}/disk.qcow2               # bootable disk linked to a base image in images
$DATA_DIR/vms/{id}/seed.iso                 # cloud-init seed iso
$DATA_DIR/vms/{id}/network-config           # rendered cloud-init network-config
$DATA_DIR/vms/{id}/meta-data                # rendered cloud-init meta-data
$DATA_DIR/vms/{id}/user-data                # rendered cloud-init user-data
*/

export class DataDir {
  private isSetup: boolean

  constructor(public readonly path: string) {
    this.isSetup = false
  }

  async listImages(): Promise<string[]> {
    await this.setup()
    const entries = await readdir(this.imagesPath(), { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
  }

  async readImageMetadata(id: string): Promise<ImageMetadata | undefined> {
    await this.setup()
    return this.readJsonFile<ImageMetadata>(this.imageMetadataPath(id))
  }

  async writeImageMetadata(id: string, metadata: ImageMetadata): Promise<void> {
    await this.setup()
    await mkdir(this.imageDirPath(id), { recursive: true })
    await writeFile(this.imageMetadataPath(id), `${JSON.stringify(metadata, null, 2)}\n`)
  }

  async readImageRequest(id: string): Promise<ImageRequest | undefined> {
    await this.setup()
    return this.readJsonFile<ImageRequest>(this.imageRequestPath(id))
  }

  async writeImageRequest(id: string, request: ImageRequest): Promise<void> {
    await this.setup()
    await mkdir(this.imageDirPath(id), { recursive: true })
    await writeFile(this.imageRequestPath(id), `${JSON.stringify(request, null, 2)}\n`)
  }

  async removeImageRequest(id: string): Promise<void> {
    await this.setup()

    try {
      await unlink(this.imageRequestPath(id))
    } catch (error: unknown) {
      const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: string }).code : undefined
      if (code === "ENOENT") {
        return
      }

      throw error
    }
  }

  async getImageDownloadPath(id: string): Promise<string> {
    await this.setup()
    await mkdir(this.imageDirPath(id), { recursive: true })
    return this.imageDownloadPath(id)
  }

  async getImagePath(id: string): Promise<string> {
    await this.setup()
    await mkdir(this.imageDirPath(id), { recursive: true })
    return this.imagePath(id)
  }

  async hasImageDownload(id: string): Promise<boolean> {
    await this.setup()
    return pathExists(this.imageDownloadPath(id))
  }

  async completeImageDownload(id: string): Promise<string> {
    await this.setup()
    const downloadPath = this.imageDownloadPath(id)
    const imagePath = this.imagePath(id)
    await rename(downloadPath, imagePath)
    return imagePath
  }

  async getVmDirPath(id: string): Promise<string> {
    await this.setup()
    return this.vmDirPath(id)
  }

  async listVms(): Promise<string[]> {
    await this.setup()
    const entries = await readdir(this.vmsPath(), { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
  }

  async readVmRequest(id: string): Promise<VmRequest | undefined> {
    await this.setup()
    return this.readJsonFile<VmRequest>(this.vmRequestPath(id))
  }

  async writeVmRequest(id: string, request: VmRequest): Promise<void> {
    await this.setup()
    await mkdir(this.vmDirPath(id), { recursive: true })
    await writeFile(this.vmRequestPath(id), `${JSON.stringify(request, null, 2)}\n`)
  }

  async removeVmRequest(id: string): Promise<void> {
    await this.setup()

    try {
      await unlink(this.vmRequestPath(id))
    } catch (error: unknown) {
      const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: string }).code : undefined
      if (code === "ENOENT") {
        return
      }

      throw error
    }
  }

  async readVmMetadata(id: string): Promise<VmMetadata | undefined> {
    await this.setup()
    return this.readJsonFile<VmMetadata>(this.vmMetadataPath(id))
  }

  async writeVmMetadata(id: string, metadata: VmMetadata): Promise<void> {
    await this.setup()
    await mkdir(this.vmDirPath(id), { recursive: true })
    await writeFile(this.vmMetadataPath(id), `${JSON.stringify(metadata, null, 2)}\n`)
  }

  async getVmDiskPath(id: string): Promise<string> {
    await this.setup()
    await mkdir(this.vmDirPath(id), { recursive: true })
    return this.vmDiskPath(id)
  }

  async getVmSeedIsoPath(id: string): Promise<string> {
    await this.setup()
    await mkdir(this.vmDirPath(id), { recursive: true })
    return this.vmSeedIsoPath(id)
  }

  async getVmXmlPath(id: string): Promise<string> {
    await this.setup()
    await mkdir(this.vmDirPath(id), { recursive: true })
    return this.vmXmlPath(id)
  }

  async getVmUserDataPath(id: string): Promise<string> {
    await this.setup()
    await mkdir(this.vmDirPath(id), { recursive: true })
    return this.vmUserDataPath(id)
  }

  async getVmMetaDataPath(id: string): Promise<string> {
    await this.setup()
    await mkdir(this.vmDirPath(id), { recursive: true })
    return this.vmMetaDataPath(id)
  }

  async getVmNetworkConfigPath(id: string): Promise<string> {
    await this.setup()
    await mkdir(this.vmDirPath(id), { recursive: true })
    return this.vmNetworkConfigPath(id)
  }

  async removeVmDir(id: string): Promise<void> {
    await this.setup()
    await this.removeDirectoryIfPresent(this.vmDirPath(id))
  }

  private async setup(): Promise<void> {
    if (this.isSetup) {
      return
    }

    await mkdir(this.imagesPath(), { recursive: true })
    await mkdir(this.vmsPath(), { recursive: true })
    this.isSetup = true
  }

  private imagesPath(): string {
    return join(this.path, "images")
  }

  private vmsPath(): string {
    return join(this.path, "vms")
  }

  private imageDirPath(id: string): string {
    return join(this.imagesPath(), id)
  }

  private imageRequestPath(id: string): string {
    return join(this.imageDirPath(id), "request.json")
  }

  private imageMetadataPath(id: string): string {
    return join(this.imageDirPath(id), "meta.json")
  }

  private imageDownloadPath(id: string): string {
    return join(this.imageDirPath(id), "image.qcow2.download")
  }

  private imagePath(id: string): string {
    return join(this.imageDirPath(id), "image.qcow2")
  }

  private vmDirPath(id: string): string {
    return join(this.vmsPath(), id)
  }

  private vmRequestPath(id: string): string {
    return join(this.vmDirPath(id), "request.json")
  }

  private vmMetadataPath(id: string): string {
    return join(this.vmDirPath(id), "meta.json")
  }

  private vmDiskPath(id: string): string {
    return join(this.vmDirPath(id), "disk.qcow2")
  }

  private vmSeedIsoPath(id: string): string {
    return join(this.vmDirPath(id), "seed.iso")
  }

  private vmXmlPath(id: string): string {
    return join(this.vmDirPath(id), "vm.xml")
  }

  private vmUserDataPath(id: string): string {
    return join(this.vmDirPath(id), "user-data")
  }

  private vmMetaDataPath(id: string): string {
    return join(this.vmDirPath(id), "meta-data")
  }

  private vmNetworkConfigPath(id: string): string {
    return join(this.vmDirPath(id), "network-config")
  }

  private async removeDirectoryIfPresent(path: string): Promise<void> {
    const basePath = resolve(this.path)
    const targetPath = resolve(path)
    const relativePath = relative(basePath, targetPath)

    if (
      relativePath.length === 0 ||
      relativePath === "." ||
      relativePath.startsWith("..") ||
      relativePath.includes("\\")
    ) {
      throw new Error(`Refusing to remove directory outside data dir: ${targetPath}`)
    }

    try {
      await stat(targetPath)
    } catch (error: unknown) {
      const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: string }).code : undefined
      if (code === "ENOENT") {
        return
      }
      throw error
    }

    await rm(targetPath, { force: true })
  }

  private async readJsonFile<T>(path: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(path, "utf8")) as T
    } catch (error: unknown) {
      const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: string }).code : undefined
      if (code === "ENOENT") {
        return undefined
      }
      throw error
    }
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error: unknown) {
    const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: string }).code : undefined
    if (code === "ENOENT") {
      return false
    }

    throw error
  }
}
