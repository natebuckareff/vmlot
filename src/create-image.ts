export interface CreateImageParams {
  url: string
}

export class CreateImage {
  private id: string;
  private progress: number; // updated from detached promise
  private hasher: unknown;  // hasher state for incrementally hashing chunks
  // TODO: probably need a promise here and maybe a status object to hold an error

  // api sends CreateImageParams and daemon creates this instance
  constructor(private dataDir: dataDir, public readonly params: CreateImageParams) {
    this.id = randomUUID();
    this.progress = 0;
  }

  await getInfo(): Promise<ImageInfo> {
    // TODO
    // get the ImageInfo
    // probably can be sync
    throw Error('todo')
  }

  async getRelativePath(): Promise<string> {
    // TODO
    // get the path of the base image relative to a vm data directory
    // will look like `../images/foo.qcow2`
    // used to create linked disk images
    throw Error('todo')
  }

  async start(): Promise<void> {
    // TODO
    // - delete any existing, abandonded `{id}.qcow2.download` file
    // - start chunked download in the background by creating a detached promise
    // - writes to `{id}.qcow2.download`
    // - renaming the .download file is responsibility of LoadImage
    throw Error('todo')
  }

  async complete(): Promise<LoadImage | undefined> {
    // TODO
    // - returns undefined if the download is still in progress
    // - returns LoadImage
    throw Error('todo')
  }

  private async getHash(): string | undefined {
    // returns hash of the image
    // calculated incrementally per chunk
    // returns undefined if download is still in progress
    throw Error('todo')
  }

  private async getDownloadProgress() {
    // returns the download progress as [0,1]
    // for rendering ImageInfo
    throw Error('todo')
  }
}
