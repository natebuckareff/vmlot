import { TailscaleConfig } from "./server-config"

interface TailscaleOAuthTokenResponse {
  access_token: string
  token_type: "Bearer"
  expires_in: number
  scope: string
}

interface CreateAuthKeyResponse {
  id: string
  key: string
  created: string
  expires: string
}

interface TailscaleClientOptions {
  clientId: string
  clientSecret: string
  tailnet: string
  authKeyExpirySeconds: number
  tags: string[]
  tokenUrl?: string
}

interface CachedAccessToken {
  accessToken: string
  expiresAtMs: number
  scope: string
  tagsKey: string
}

export interface TailscaleDevice {
  id: string
  name?: string
  hostname?: string
  addresses?: string[]
}

interface TailscaleDevicesResponse {
  devices?: TailscaleDevice[]
}

export class TailscaleClient {
  private readonly clientId: string
  private readonly clientSecret: string
  private readonly tailnet: string
  private readonly authKeyExpirySeconds: number
  private readonly tags: string[]
  private readonly tokenUrl: string
  private cachedAccessToken?: CachedAccessToken

  constructor(options: TailscaleClientOptions) {
    this.clientId = options.clientId
    this.clientSecret = options.clientSecret
    this.tailnet = options.tailnet
    this.authKeyExpirySeconds = options.authKeyExpirySeconds
    this.tags = options.tags
    this.tokenUrl = options.tokenUrl ?? "https://api.tailscale.com/api/v2/oauth/token"
  }

  static fromConfig(config: TailscaleConfig): TailscaleClient {
    return new TailscaleClient({
      clientId: config.oauthClientId,
      clientSecret: config.oauthClientSecret,
      tailnet: config.tailnet,
      authKeyExpirySeconds: config.authKeyExpirySeconds,
      tags: config.tags,
    })
  }

  async createAuthKey(description: string): Promise<CreateAuthKeyResponse> {
    const accessToken = await this.getAccessToken("auth_keys", this.tags)
    const response = await fetch(`https://api.tailscale.com/api/v2/tailnet/${this.tailnet}/keys`, {
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
    })

    if (!response.ok) {
      throw new Error(`Tailscale auth key creation failed: ${response.status} ${await response.text()}`)
    }

    return (await response.json()) as CreateAuthKeyResponse
  }

  async listDevices(): Promise<TailscaleDevice[]> {
    const accessToken = await this.getAccessToken("devices:read")
    const response = await fetch(`https://api.tailscale.com/api/v2/tailnet/${this.tailnet}/devices`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    })

    if (!response.ok) {
      throw new Error(`Tailscale list devices failed: ${response.status} ${await response.text()}`)
    }

    const payload = (await response.json()) as TailscaleDevicesResponse
    return payload.devices ?? []
  }

  async findDeviceByHostname(hostname: string): Promise<TailscaleDevice | undefined> {
    const normalizedHostname = hostname.trim().toLowerCase()
    const devices = await this.listDevices()

    return devices.find((device) => matchesHostname(device, normalizedHostname))
  }

  async findDeviceById(id: string): Promise<TailscaleDevice | undefined> {
    const normalizedId = id.trim()
    const devices = await this.listDevices()
    return devices.find((device) => device.id === normalizedId)
  }

  private async getAccessToken(scope: string, tags?: string[]): Promise<string> {
    const now = Date.now()
    const normalizedTags = (tags ?? []).map((tag) => tag.trim()).filter((tag) => tag.length > 0)
    const tagsKey = normalizedTags.join(" ")

    if (
      this.cachedAccessToken &&
      this.cachedAccessToken.scope === scope &&
      this.cachedAccessToken.tagsKey === tagsKey &&
      this.cachedAccessToken.expiresAtMs > now + 30_000
    ) {
      return this.cachedAccessToken.accessToken
    }

    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      scope,
    })

    if (normalizedTags.length > 0) {
      body.set("tags", normalizedTags.join(" "))
    }

    const response = await fetch(this.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    })

    if (!response.ok) {
      throw new Error(`Tailscale OAuth failed: ${response.status} ${await response.text()}`)
    }

    const payload = (await response.json()) as TailscaleOAuthTokenResponse
    this.cachedAccessToken = {
      accessToken: payload.access_token,
      expiresAtMs: now + payload.expires_in * 1000,
      scope,
      tagsKey,
    }
    return payload.access_token
  }
}

function matchesHostname(device: TailscaleDevice, normalizedHostname: string): boolean {
  const candidates = [
    device.hostname,
    device.name,
    device.name?.split(".")[0],
  ]

  return candidates.some((candidate) => candidate?.trim().toLowerCase() === normalizedHostname)
}
