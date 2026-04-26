import type { Id } from "./id"

export interface VmInfo {
  id: Id
  name: string
  status: VmStatus
  createdAt?: number
  baseImageId?: Id
  baseImageName: string
  memory: number
  vcpu: number
  address?: string
  error?: string
}

export interface VmRequest {
  name: string
  createdAt?: number
  baseImageId: Id
  user: string
  sshPublicKey: string
  tailscaleAuthKey: string
  memory: number
  vcpu: number
}

export interface VmMetadata {
  id: Id
  name: string
  createdAt?: number
  baseImageId: Id
  baseImageName: string
  memory: number
  vcpu: number
  user: string
  tailscaleDeviceId?: string
}

export interface CreateVmParams {
  name: string
  createdAt?: number
  baseImageId: Id
  user: string
  sshPublicKey: string
  tailscaleAuthKey: string
  memory: number
  vcpu: number
}

export interface CreateVmInput {
  name: string
  baseImageId: string
  user: string
  sshPublicKey: string
  memory: number
  vcpu: number
}

export type VmStatus =
  | "creating"
  | "create-fail"
  | "create-interrupted"
  | "stopped"
  | "running"
