import { runCommand } from "./util"
import { VmStatus } from "./vm"

export type LibvirtDomainState =
  | "no-state"
  | "running"
  | "idle"
  | "paused"
  | "shutdown"
  | "shut-off"
  | "crashed"
  | "pmsuspended"
  | "in-shutdown"
  | "unknown"

export interface LibvirtVmState {
  name: string
  state: LibvirtDomainState
  rawState: string
  vmStatus: VmStatus
}

export interface GuestIpAddressInfo {
  ipAddress: string
  ipAddressType: "ipv4" | "ipv6"
  prefix: number
}

export interface GuestInterfaceInfo {
  name: string
  hardwareAddress?: string
  ipAddresses: GuestIpAddressInfo[]
}

export class LibvirtClient {
  define(vmXmlPath: string): void {
    this.runVirsh(["define", vmXmlPath], "virsh define failed")
  }

  create(vmXmlPath: string): void {
    this.runVirsh(["create", vmXmlPath], "virsh create failed")
  }

  destroy(name: string): void {
    this.runVirsh(["destroy", name], "virsh destroy failed")
  }

  undefine(name: string): void {
    this.runVirsh(["undefine", "--nvram", name], "virsh undefine failed")
  }

  getState(name: string): LibvirtVmState | undefined {
    const result = this.runVirsh(["domstate", name], undefined, true)

    if (result.exitCode !== 0) {
      const stderr = result.stderr.toString().trim()
      const stdout = result.stdout.toString().trim()
      const combined = [stdout, stderr].filter(Boolean).join("\n")

      if (isMissingDomainError(combined)) {
        return undefined
      }

      throw new Error(
        [
          `virsh domstate failed for ${name}`,
          stdout && `stdout:\n${stdout}`,
          stderr && `stderr:\n${stderr}`,
        ]
          .filter(Boolean)
          .join("\n\n"),
      )
    }

    const rawState = normalizeVirshOutput(result.stdout.toString())
    const state = parseLibvirtDomainState(rawState)

    return {
      name,
      state,
      rawState,
      vmStatus: mapLibvirtStateToVmStatus(state),
    }
  }

  getGuestInterfaces(name: string): GuestInterfaceInfo[] {
    const command = JSON.stringify({
      execute: "guest-network-get-interfaces",
    })
    const result = this.runVirsh(
      ["qemu-agent-command", name, command],
      `virsh qemu-agent-command failed for ${name}`,
    )
    const payload = JSON.parse(result.stdout.toString()) as { return?: unknown }

    if (!Array.isArray(payload.return)) {
      throw new Error(`Guest agent response did not include an interface list for ${name}`)
    }

    return payload.return.map((value, index) => parseGuestInterfaceInfo(value, name, index))
  }

  private runVirsh(command: string[], errorPrefix?: string, allowFailure = false) {
    return runCommand(["virsh", ...command], {
      allowFailure,
      errorPrefix,
    })
  }
}

export function parseLibvirtDomainState(value: string): LibvirtDomainState {
  switch (normalizeVirshOutput(value)) {
    case "no state":
      return "no-state"

    case "running":
      return "running"

    case "idle":
      return "idle"

    case "paused":
      return "paused"

    case "shutdown":
      return "shutdown"

    case "shut off":
      return "shut-off"

    case "crashed":
      return "crashed"

    case "pmsuspended":
      return "pmsuspended"

    case "in shutdown":
      return "in-shutdown"

    default:
      return "unknown"
  }
}

export function mapLibvirtStateToVmStatus(state: LibvirtDomainState): VmStatus {
  switch (state) {
    case "running":
    case "idle":
    case "paused":
    case "in-shutdown":
      return "running"

    case "no-state":
    case "shutdown":
    case "shut-off":
    case "crashed":
    case "pmsuspended":
    case "unknown":
      return "stopped"
  }
}

function normalizeVirshOutput(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ")
}

function isMissingDomainError(message: string): boolean {
  const normalized = message.toLowerCase()
  return normalized.includes("failed to get domain") || normalized.includes("domain not found")
}

function parseGuestInterfaceInfo(value: unknown, vmName: string, index: number): GuestInterfaceInfo {
  if (typeof value !== "object" || value === null) {
    throw new Error(`Guest interface ${index} for ${vmName} was not an object`)
  }

  if (!("name" in value) || typeof value.name !== "string") {
    throw new Error(`Guest interface ${index} for ${vmName} did not include a valid name`)
  }

  const hardwareAddress =
    "hardware-address" in value && typeof value["hardware-address"] === "string"
      ? value["hardware-address"]
      : undefined

  const ipAddresses = parseGuestIpAddresses(
    "ip-addresses" in value ? value["ip-addresses"] : undefined,
    vmName,
    value.name,
  )

  return {
    name: value.name,
    hardwareAddress,
    ipAddresses,
  }
}

function parseGuestIpAddresses(value: unknown, vmName: string, interfaceName: string): GuestIpAddressInfo[] {
  if (value === undefined) {
    return []
  }

  if (!Array.isArray(value)) {
    throw new Error(`Guest interface ${interfaceName} for ${vmName} had invalid ip-addresses`)
  }

  return value.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`Guest IP address ${index} for ${interfaceName} on ${vmName} was not an object`)
    }

    const ipAddress = "ip-address" in entry && typeof entry["ip-address"] === "string" ? entry["ip-address"] : undefined
    const ipAddressType =
      "ip-address-type" in entry && (entry["ip-address-type"] === "ipv4" || entry["ip-address-type"] === "ipv6")
        ? entry["ip-address-type"]
        : undefined
    const prefix = "prefix" in entry && typeof entry.prefix === "number" ? entry.prefix : undefined

    if (!ipAddress || !ipAddressType || prefix === undefined) {
      throw new Error(`Guest IP address ${index} for ${interfaceName} on ${vmName} was incomplete`)
    }

    return {
      ipAddress,
      ipAddressType,
      prefix,
    }
  })
}
