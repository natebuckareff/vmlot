export interface VmInfo {
  id: strind, // uuid
  name: string,
  status: VmStatus,
  baseImageName: string, // ImageInfo['name']
  memory: number,        // in MiB
  vcpu: number,
}

export type VmStatus = 'stopped' | 'running'
