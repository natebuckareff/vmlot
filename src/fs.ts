import { rm, stat, unlink } from "node:fs/promises"

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
