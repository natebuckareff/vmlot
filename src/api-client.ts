import { Api } from "./api"
import { CreateImageParams } from "./create-image"
import { ImageInfo } from "./image"
import { CreateVmParams, VmInfo } from "./vm"

interface ApiSuccess<T> {
  data: T
}

interface ApiFailure {
  error: {
    message: string
  }
}

export class ApiClient implements Api {
  constructor(private readonly baseUrl: string) {}

  async listVms(): Promise<VmInfo[]> {
    return this.post<VmInfo[]>("/api/list-vms", {})
  }

  async listImages(): Promise<ImageInfo[]> {
    return this.post<ImageInfo[]>("/api/list-images", {})
  }

  async createVm(params: CreateVmParams): Promise<VmInfo> {
    return this.post<VmInfo>("/api/create-vm", params)
  }

  async removeVm(id: string): Promise<void> {
    return this.post<void>("/api/remove-vm", { id })
  }

  async createImage(params: CreateImageParams): Promise<ImageInfo> {
    return this.post<ImageInfo>("/api/create-image", params)
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(new URL(path, normalizedBaseUrl(this.baseUrl)), {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    })

    const payload = (await response.json()) as ApiSuccess<T> | ApiFailure

    if (!response.ok) {
      if ("error" in payload) {
        throw new Error(payload.error.message)
      }

      throw new Error(`HTTP ${response.status} ${response.statusText}`)
    }

    if (!("data" in payload)) {
      throw new Error("API response did not include data")
    }

    return payload.data
  }
}

function normalizedBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`
}
