import { formatCliId, type Id } from "./id";

export const DEFAULT_VM_USER = "vmlot";

export interface VmInfo {
  id: Id;
  name: string;
  status: VmStatus;
  createdAt?: number;
  baseImageId?: Id;
  baseImageName: string;
  diskUsageBytes?: number;
  memory: number;
  vcpu: number;
  address?: string;
  error?: string;
}

export interface VmRequest {
  name: string;
  createdAt?: number;
  baseImageId: Id;
  user: string;
  sshPublicKey: string;
  tailscaleAuthKey: string;
  memory: number;
  vcpu: number;
}

export interface VmMetadata {
  id: Id;
  name: string;
  createdAt?: number;
  baseImageId: Id;
  baseImageName: string;
  memory: number;
  vcpu: number;
  user: string;
  tailscaleDeviceId: string;
}

export interface CreateVmParams {
  name: string;
  createdAt?: number;
  baseImageId: Id;
  user: string;
  sshPublicKey: string;
  tailscaleAuthKey: string;
  memory: number;
  vcpu: number;
}

export interface CreateVmInput {
  name: string;
  baseImageId: string;
  user?: string;
  sshPublicKey: string;
  memory: number;
  vcpu: number;
}

export type VmStatus =
  | "preparing"
  | "creating"
  | "connecting" // TODO: not a fan of this; ideally, we have vm telemetry
  | "create-fail"
  | "create-interrupted"
  | "stopping"
  | "stopped"
  | "running";

export function getVmHostname(name: string, id: Id): string {
  return `${name}-${formatCliId(id)}`;
}

export function isVmCreateInProgress(status: VmStatus): boolean {
  return (
    status === "preparing" || status === "creating" || status === "connecting"
  );
}
