import {
  DEFAULT_SERVER_PORT,
  type ServerRegistryEntry,
} from "./server-registry";
import type { TailscaleClient, TailscaleDevice } from "./tailscale-client";

const VMLOT_SERVER_TAG = "tag:vmlot-server";

export class ServerDiscovery {
  constructor(private readonly tailscale: TailscaleClient) {}

  async list(): Promise<ServerRegistryEntry[]> {
    const devices = await this.tailscale.listDevices();
    return devices
      .filter((device) => hasTag(device, VMLOT_SERVER_TAG))
      .map(deviceToServer)
      .filter(
        (server): server is ServerRegistryEntry => server.endpoint.host !== "",
      )
      .sort((left, right) => left.name.localeCompare(right.name));
  }
}

function hasTag(device: TailscaleDevice, tag: string): boolean {
  const normalizedTag = tag.trim().toLowerCase();
  return (
    device.tags?.some(
      (deviceTag) => deviceTag.trim().toLowerCase() === normalizedTag,
    ) ?? false
  );
}

function deviceToServer(device: TailscaleDevice): ServerRegistryEntry {
  return {
    name: deviceHostname(device) ?? device.id,
    endpoint: {
      host: deviceAddress(device) ?? "",
      port: DEFAULT_SERVER_PORT,
    },
  };
}

function deviceHostname(device: TailscaleDevice): string | undefined {
  return [device.hostname, device.name?.split(".")[0], device.name]
    .map((candidate) => candidate?.trim())
    .find((candidate): candidate is string => Boolean(candidate));
}

function deviceAddress(device: TailscaleDevice): string | undefined {
  const addresses = device.addresses ?? [];
  return addresses.find((address) => address.includes(".")) ?? addresses[0];
}
