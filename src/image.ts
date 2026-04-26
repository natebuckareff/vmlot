export interface ImageInfo {
  id: string,         // uuid
  name: string,       // normalized name
  url: string,        // original url
  status: ImageStatus
  hash?: string,      // hex-encoded sha256 hash, available after download
  progress: number,   // download progress
  error?: string      // error message if download failed
}

// only created _after_ download finishes
export interface ImageMetadata {
  id: string,
  name: string,
  url: string,
  hash: string,
}

export type ImageStatus =
  | 'downloading'           // download in-progress, healthy state
  | 'download-fail'         // error mid-download
  | 'download-interrupted'  // server crashed in middle of a download
  | 'ready'                 // no .download files in a healthy image dir

