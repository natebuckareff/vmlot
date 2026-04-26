export class HttpServer {
  private server: ApiServer

  constructor() {
    this.server = new ApiServer()
  }

  listen(): Promise<void> {
    // start listening for POST requests on 0.0.0.0:1234
    throw Error('todo')
  }

  private handleRequest(request: unknown) {
    // check the command name and delegate to correct server method
    // return `{ data: <result> }` on success
    // return `{ error: { message: string }` on error
    throw Error('todo')
  }
}
