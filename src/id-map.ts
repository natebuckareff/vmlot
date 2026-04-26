import type { Id } from "./id"

export class IdMap<T> {
  private readonly map: Map<Id, T>
  private readonly ids: Id[]

  constructor(private readonly kind: string) {
    this.map = new Map()
    this.ids = []
  }

  entries(): IterableIterator<[Id, T]> {
    return this.map.entries()
  }

  keys(): IterableIterator<Id> {
    return this.map.keys()
  }

  set(id: Id, value: T): this {
    if (!this.map.has(id)) {
      const index = lowerBound(this.ids, id)
      this.ids.splice(index, 0, id)
    }

    this.map.set(id, value)
    return this
  }

  get(id: string): T | undefined {
    const resolvedId = this.tryResolve(id)
    if (!resolvedId) {
      return undefined
    }

    return this.map.get(resolvedId)
  }

  resolve(id: string): Id {
    const resolvedId = this.tryResolve(id)
    if (!resolvedId) {
      throw new Error(`${this.kind} not found: ${id}`)
    }

    return resolvedId
  }

  delete(id: string): boolean {
    const resolvedId = this.tryResolve(id)
    if (!resolvedId) {
      return false
    }

    const deleted = this.map.delete(resolvedId)
    if (!deleted) {
      return false
    }

    const index = lowerBound(this.ids, resolvedId)
    if (this.ids[index] === resolvedId) {
      this.ids.splice(index, 1)
    }

    return true
  }

  private tryResolve(id: string): Id | undefined {
    const startIndex = lowerBound(this.ids, id)
    const match = this.ids[startIndex]

    if (!match || !match.startsWith(id)) {
      return undefined
    }

    const nextMatch = this.ids[startIndex + 1]
    if (nextMatch?.startsWith(id)) {
      throw new Error(`Ambiguous ${this.kind} ID prefix: ${id}`)
    }

    return match
  }
}

function lowerBound(values: Id[], target: string): number {
  let low = 0
  let high = values.length

  while (low < high) {
    const mid = low + Math.floor((high - low) / 2)
    const value = values[mid]

    if (value !== undefined && value < target) {
      low = mid + 1
      continue
    }

    high = mid
  }

  return low
}
