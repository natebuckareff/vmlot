import { randomBytes } from "node:crypto"

const ID_SIZE_BYTES = 32
const CLI_ID_DISPLAY_BYTES = 12
const FULL_ID_HEX_LENGTH = ID_SIZE_BYTES * 2

declare const idBrand: unique symbol

export type Id = string & { readonly [idBrand]: "Id" }

export function generateId(): Id {
  return toId(randomBytes(ID_SIZE_BYTES).toString("hex"))
}

export function formatCliId(id: string): string {
  return id.slice(0, CLI_ID_DISPLAY_BYTES * 2)
}

export function isFullId(value: string): value is Id {
  return value.length === FULL_ID_HEX_LENGTH && /^[0-9a-f]+$/.test(value)
}

export function toId(value: string): Id {
  if (!isFullId(value)) {
    throw new Error(`Invalid full ID: ${value}`)
  }

  return value
}
