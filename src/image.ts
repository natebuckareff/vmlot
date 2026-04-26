import type { Id } from "./id"

export interface ImageRequest {
  name: string,
  url: string,
  createdAt?: number,
}

export interface ImageInfo {
  id: Id,             // 32 random bytes, hex encoded
  name: string,       // user-provided name
  url: string,        // original url
  status: ImageStatus
  createdAt?: number  // unix timestamp in milliseconds
  hash?: string,      // hex-encoded sha256 hash, available after download
  sizeBytes?: number
  progress: number,   // download progress
  error?: string      // error message if download failed
}

// only created _after_ download finishes
export interface ImageMetadata {
  id: Id,
  name: string,
  url: string,
  createdAt?: number,
  hash: string,
}

export type ImageStatus =
  | 'downloading'           // download in-progress, healthy state
  | 'download-fail'         // error mid-download
  | 'download-interrupted'  // server crashed in middle of a download
  | 'ready'                 // no .download files in a healthy image dir
