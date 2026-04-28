import { HttpClient } from "./http-client";
import type { TailscaleConfig } from "./server-config";

const DEVICE_WAIT_POLL_MS = 2_000;
const LIST_DEVICES_REQUEST_KEY = "tailscale:list-devices";

interface TailscaleOAuthTokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  scope: string;
}

interface CreateAuthKeyResponse {
  id: string;
  key: string;
  created: string;
  expires: string;
}

interface TailscaleClientOptions {
  clientId: string;
  clientSecret: string;
  tailnet: string;
  authKeyExpirySeconds: number;
  tags: string[];
  tokenUrl?: string;
}

interface CachedAccessToken {
  accessToken: string;
  expiresAtMs: number;
  scope: string;
  tagsKey: string;
}

export interface TailscaleDevice {
  id: string;
  name?: string;
  hostname?: string;
  addresses?: string[];
  tags?: string[];
}

interface TailscaleDevicesResponse {
  devices?: TailscaleDevice[];
}

export class TailscaleClient {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly tailnet: string;
  private readonly authKeyExpirySeconds: number;
  private readonly tags: string[];
  private readonly tokenUrl: string;
  private readonly httpClient: HttpClient;
  private cachedAccessToken?: CachedAccessToken;

  constructor(options: TailscaleClientOptions) {
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.tailnet = options.tailnet;
    this.authKeyExpirySeconds = options.authKeyExpirySeconds;
    this.tags = options.tags;
    this.tokenUrl =
      options.tokenUrl ?? "https://api.tailscale.com/api/v2/oauth/token";
    this.httpClient = new HttpClient();
  }

  static fromConfig(config: TailscaleConfig): TailscaleClient {
    return new TailscaleClient({
      clientId: config.oauthClientId,
      clientSecret: config.oauthClientSecret,
      tailnet: config.tailnet,
      authKeyExpirySeconds: config.authKeyExpirySeconds,
      tags: config.tags,
    });
  }

  async createAuthKey(description: string): Promise<CreateAuthKeyResponse> {
    const accessToken = await this.getAccessToken("auth_keys", this.tags);
    const response = await this.httpClient.fetch(
      `https://api.tailscale.com/api/v2/tailnet/${this.tailnet}/keys`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          capabilities: {
            devices: {
              create: {
                reusable: false,
                ephemeral: false,
                preauthorized: true,
                tags: this.tags,
              },
            },
          },
          expirySeconds: this.authKeyExpirySeconds,
          description,
        }),
      },
    );

    if (!response.ok) {
      throw new Error(
        `Tailscale auth key creation failed: ${response.status} ${await response.text()}`,
      );
    }

    return (await response.json()) as CreateAuthKeyResponse;
  }

  async listDevices(): Promise<TailscaleDevice[]> {
    const accessToken = await this.getAccessToken("devices:core:read");
    const url = new URL(
      `https://api.tailscale.com/api/v2/tailnet/${this.tailnet}/devices`,
    );
    url.searchParams.set("fields", "all");
    const response = await this.httpClient.fetch(url, {
      requestKey: LIST_DEVICES_REQUEST_KEY,
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      throw new Error(
        `Tailscale list devices failed: ${response.status} ${await response.text()}`,
      );
    }

    const payload = (await response.json()) as TailscaleDevicesResponse;
    return payload.devices ?? [];
  }

  async findDeviceByHostname(
    hostname: string,
  ): Promise<TailscaleDevice | undefined> {
    const normalizedHostname = hostname.trim().toLowerCase();
    const devices = await this.listDevices();

    return devices.find((device) =>
      matchesHostname(device, normalizedHostname),
    );
  }

  async findDeviceById(id: string): Promise<TailscaleDevice | undefined> {
    const normalizedId = id.trim();
    const devices = await this.listDevices();
    return devices.find((device) => device.id === normalizedId);
  }

  async waitForDeviceByHostname(hostname: string): Promise<TailscaleDevice> {
    const normalizedHostname = normalizeHostname(hostname);

    while (true) {
      try {
        const device = await this.findDeviceByHostname(normalizedHostname);
        if (device) {
          return device;
        }
      } catch (error: unknown) {
        if (!isRetryableDeviceWaitError(error)) {
          throw error;
        }
      }

      await Bun.sleep(DEVICE_WAIT_POLL_MS);
    }
  }

  async deleteDevice(id: string): Promise<void> {
    const accessToken = await this.getAccessToken("devices:core", this.tags);
    const normalizedId = id.trim();
    const response = await this.httpClient.fetch(
      `https://api.tailscale.com/api/v2/device/${normalizedId}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    );

    if (response.status === 404) {
      return;
    }

    if (!response.ok) {
      throw new Error(
        `Tailscale delete device failed: ${response.status} ${await response.text()}`,
      );
    }
  }

  private async getAccessToken(
    scope: string,
    tags?: string[],
  ): Promise<string> {
    const now = Date.now();
    const normalizedTags = (tags ?? [])
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0);
    const tagsKey = normalizedTags.join(" ");

    if (
      this.cachedAccessToken &&
      this.cachedAccessToken.scope === scope &&
      this.cachedAccessToken.tagsKey === tagsKey &&
      this.cachedAccessToken.expiresAtMs > now + 30_000
    ) {
      return this.cachedAccessToken.accessToken;
    }

    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      scope,
    });

    if (normalizedTags.length > 0) {
      body.set("tags", normalizedTags.join(" "));
    }

    const response = await this.httpClient.fetch(this.tokenUrl, {
      requestKey: `tailscale:oauth:${scope}:${tagsKey}`,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });

    if (!response.ok) {
      throw new Error(
        `Tailscale OAuth failed: ${response.status} ${await response.text()}`,
      );
    }

    const payload = (await response.json()) as TailscaleOAuthTokenResponse;
    this.cachedAccessToken = {
      accessToken: payload.access_token,
      expiresAtMs: now + payload.expires_in * 1000,
      scope,
      tagsKey,
    };
    return payload.access_token;
  }
}

function matchesHostname(
  device: TailscaleDevice,
  normalizedHostname: string,
): boolean {
  return getDeviceHostnameCandidates(device).includes(normalizedHostname);
}

function getDeviceHostnameCandidates(device: TailscaleDevice): string[] {
  return [device.hostname, device.name, device.name?.split(".")[0]]
    .map((candidate) => candidate?.trim().toLowerCase())
    .filter((candidate): candidate is string => Boolean(candidate));
}

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase();
}

function isRetryableDeviceWaitError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.startsWith("Tailscale list devices failed:") ||
      error.message.startsWith("Tailscale OAuth failed:"))
  );
}
