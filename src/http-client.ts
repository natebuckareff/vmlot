const MAX_REQUEST_DELAY = 1000

interface PendingRequest {
  input: Parameters<typeof fetch>[0]
  init?: Parameters<typeof fetch>[1]
  resolve: (response: Response) => void
  reject: (error: unknown) => void
}

export class HttpClient {
  private queue: PendingRequest[] = []
  private fetchPromise?: Promise<void>

  fetch(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> {
    const promise = new Promise<Response>((resolve, reject) => {
      this.queue.push({
        input,
        init,
        resolve,
        reject,
      })
    })

    if (!this.fetchPromise) {
      this.fetchPromise = this.startFetch()
    }

    return promise
  }

  private async startFetch(): Promise<void> {
    try {
      while (this.queue.length > 0) {
        const request = this.queue.shift()
        if (!request) {
          continue
        }

        const startedAt = performance.now()

        try {
          const response = await fetch(request.input, request.init)
          request.resolve(response)
        } catch (error: unknown) {
          request.reject(error)
        }

        const elapsed = performance.now() - startedAt
        const remainingDelay = MAX_REQUEST_DELAY - elapsed

        if (remainingDelay > 0) {
          await Bun.sleep(remainingDelay)
        }
      }
    } finally {
      this.fetchPromise = undefined

      if (this.queue.length > 0) {
        this.fetchPromise = this.startFetch()
      }
    }
  }
}
