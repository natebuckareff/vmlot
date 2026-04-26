import { ImageMetadata } from './image'

/*
data directory structure:

$DATA_DIR/images/{id}/meta.json             # metadata for the image
$DATA_DIR/images/{id}/image.qcow2           # downloaded base disk image
$DATA_DIR/images/{id}/image.qcow2.download  # downloaded base disk image
$DATA_DIR/vms/{id}/vm.json                  # config data for the vm
$DATA_DIR/vms/{id}/vm.xml                   # libvirt config file, derived from vm.json
$DATA_DIR/vms/{id}/disk.qcow2               # bootable disk linked to a base image in images
$DATA_DIR/vms/{id}/seed.iso                 # cloud-init seed iso
$DATA_DIR/vms/{id}/network-config           # cloud-init derived from vm.json
$DATA_DIR/vms/{id}/meta-data                # cloud-init derived from vm.json
$DATA_DIR/vms/{id}/user-data                # cloud-init derived from vm.json
*/

export class DataDir {
  private isSetup: boolean

  constructor(public readonly path: string) {
    this.isSetup = false;
  }

  async listImages(): Primise<string[]> {
    this.setup()
    // TODO: return list of all image ids in `{dataDir}/images`
  }

  async readImageMetadata(id: string): Promise<ImageMetadata | undefined> {
    this.setup()
    // TODO: reads image metadata from `{dataDir}/images/{id}/meta.json`
    // returns undefined if doesn't exist
    throw Error('todo')
  }

  async writeImageMetadata(id: string, metadata: ImageMetadata): Promise<void> {
    this.setup()
    // TODO: writes image metadata to `{dataDir}/images/{id}/meta.json`
    throw Error('todo')
  }

  async getImageDownloadPath(id: string): Promise<string> {
    this.setup()
    // TODO: return partial download file `{dataDir}/images/{id}/image.qcow2.download`
    // once the download is finished this is atomically renamed to drop `.download` ext
    throw Error('todo')
  }

  async completeImageDownload(id: string): Promise<string> {
    this.setup()
    // TODO: renames `{id}/image.qcow2.download` -> `{id}/image.qcow2`
    throw Error('todo')
  }

  // TODO: will do vm stuff later

  private async setup(): Promise<void> {
    if (this.isSetup) {
      return
    }
    // TODO
    // - check that `this.path` exists and is a directory, and contains `images` and `vms` dirs
    // - otherwise create it, with those two dirs empty
    this.isSetup = true
  }
}
