import { Api } from './api'
import { VmInfo } from './vm'
import { ImageInfo } from './image'
import { CreateImageParams, CreateImage } from './create-image'

export class ApiClient implements Api {
  async listVms(): Promise<VmInfo[]> {
    // POST /api/list-vms
    // -> { data: VmInfo[] }
    // sorted by name
    throw Error('todo')
  }

  async listImages(): Promise<ImageInfo[]> {
    // POST /api/list-vms
    // -> { data: ImageInfo[] }
    // sorted by name
    throw Error('todo')
  }

  async createImage(command: CreateImageParams): Promise<CreateImage> {
    // POST /api/create-image body=CreateImageParams
    // -> { data: ImageInfo }
    throw Error('todo')
  }
}
