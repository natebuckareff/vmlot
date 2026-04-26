import { rm, stat, unlink } from "node:fs/promises"

export async function assertFileExists(path: string): Promise<void> {
  try {
    await stat(path)
  } catch (error: unknown) {
    const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: string }).code : undefined
    if (code === "ENOENT") {
      throw new Error(`Required file not found: ${path}`)
    }

    throw error
  }
}

export async function removeDirectoryIfPresent(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true })
}

export async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error: unknown) {
    const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: string }).code : undefined
    if (code === "ENOENT") {
      return
    }

    throw error
  }
}
