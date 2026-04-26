import { VmInfo } from './vm'
import { ImageInfo } from './image'
import { CreateImageParams } from './create-image'

export interface Api {
  listVms(): Promise<VmInfo[]>
  listImages(): Promise<ImageInfo[]>
  createImage(params: CreateImageParams): Promise<ImageInfo>
}
