import { VmInfo } from './vm'
import { ImageInfo } from './image'
import { CreateImagePArams } from './create-image'

export interface Api {
  listVms(): Promise<VmInfo[]>
  listImages(): Promise<ImageInfo[]>
  createImage(command: CreateImageParams): Promise<CreateImage>
}
