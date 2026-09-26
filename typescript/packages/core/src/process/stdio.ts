import { Channel, JobConsole } from '../shell/console/index.ts'
import { PipeConsole } from '../shell/console/pipe.ts'
import { PipeClosed } from '../shell/errors.ts'

export class ProcessInput {
  private readonly pipe = new PipeConsole()
  private closed = false
  bytesRead = 0

  async write(data: Uint8Array): Promise<void> {
    if (data.byteLength === 0) return
    if (this.closed) throw new PipeClosed()
    for (let start = 0; start < data.byteLength; start += 65536)
      await this.pipe.emit(Channel.STDOUT, data.slice(start, start + 65536))
  }

  close(): void {
    this.closed = true
    this.pipe.end()
  }
  stop(): void {
    this.close()
    this.pipe.closeReader()
  }
  async *stream(): AsyncIterable<Uint8Array> {
    for await (const chunk of this.pipe.stream()) {
      this.bytesRead += chunk.byteLength
      yield chunk
    }
  }
}

export class ProcessOutput extends JobConsole {
  readonly stdout = new ProcessInput()
  readonly stderr = new ProcessInput()

  constructor(private readonly mergeStderr = false) {
    super()
  }

  override async emit(channel: Channel, data: Uint8Array): Promise<void> {
    await (channel === Channel.STDERR && !this.mergeStderr ? this.stderr : this.stdout).write(data)
  }

  end(): void {
    this.stdout.close()
    this.stderr.close()
  }
  stop(): void {
    this.stdout.stop()
    this.stderr.stop()
  }
}
