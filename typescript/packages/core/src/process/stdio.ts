import { Channel, JobConsole } from '../shell/console/index.ts'
import { BytePipe, CAPACITY } from '../io/pipe.ts'
import { PipeClosed } from '../io/errors.ts'

export class ProcessInput {
  private readonly pipe: BytePipe
  private closed = false
  bytesRead = 0

  constructor(capacity = CAPACITY) {
    this.pipe = new BytePipe(capacity)
  }

  async write(data: Uint8Array): Promise<void> {
    if (data.byteLength === 0) return
    if (this.closed) throw new PipeClosed()
    await this.pipe.write(data)
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
  readonly stdout: ProcessInput
  readonly stderr: ProcessInput

  constructor(
    private readonly mergeStderr = false,
    bufferBytes = CAPACITY,
  ) {
    super()
    this.stdout = new ProcessInput(bufferBytes)
    this.stderr = new ProcessInput(bufferBytes)
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
