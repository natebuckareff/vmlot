import type { CreateVmInput, VmInfo } from "./vm";
import type { ImageInfo } from "./image";
import type { CreateImageParams } from "./create-image";

export interface Api {
  ping(): Promise<void>;
  listVms(): Promise<VmInfo[]>;
  listImages(): Promise<ImageInfo[]>;
  createVm(params: CreateVmInput): Promise<VmInfo>;
  startVm(id: string): Promise<void>;
  stopVm(id: string): Promise<void>;
  removeVm(id: string): Promise<void>;
  createImage(params: CreateImageParams): Promise<ImageInfo>;
  removeImage(id: string): Promise<void>;
}
