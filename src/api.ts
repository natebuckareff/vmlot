import { VmInfo } from './vm'
import { ImageInfo } from './image'
import { CreateImageParams } from './create-image'
import { CreateVmParams } from './vm'

export interface Api {
  listVms(): Promise<VmInfo[]>
  listImages(): Promise<ImageInfo[]>
  createVm(params: CreateVmParams): Promise<VmInfo>
  startVm(id: string): Promise<void>
  stopVm(id: string): Promise<void>
  removeVm(id: string): Promise<void>
  createImage(params: CreateImageParams): Promise<ImageInfo>
  removeImage(id: string): Promise<void>
}
