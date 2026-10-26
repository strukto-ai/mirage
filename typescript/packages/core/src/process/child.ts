import { PipeClosed } from '../shell/errors.ts'
import { materialize } from '../io/types.ts'
import type { ProcessHandle } from './handle.ts'
import type { ProcessInfo } from './types.ts'
import type { ProcessInput, ProcessOutput } from './stdio.ts'

export interface ProcessResult {
  readonly stdout: Uint8Array
  readonly stderr: Uint8Array
  readonly exitCode: number
}

/** Streams belong to one consumer; communicate drains both outputs concurrently. */
export class ChildProcess {
  readonly stdout: AsyncIterable<Uint8Array>
  readonly stderr: AsyncIterable<Uint8Array>
  constructor(
    private readonly process: ProcessHandle,
    readonly stdin: ProcessInput,
    private readonly output: ProcessOutput,
    private readonly cancel: () => void,
  ) {
    void process.join().then(() => {
      stdin.stop()
      output.end()
    })
    this.stdout = output.stdout.stream()
    this.stderr = output.stderr.stream()
  }
  get pid(): number {
    return this.process.info.pid
  }
  closeOutput(stream: 'stdout' | 'stderr'): void {
    this.output[stream].stop()
  }
  poll(): number | null {
    return this.process.info.exitCode
  }
  terminate(): void {
    this.cancel()
  }
  wait(): Promise<ProcessInfo> {
    return this.process.join()
  }
  async communicate(data: Uint8Array = new Uint8Array()): Promise<ProcessResult> {
    const feed = async () => {
      try {
        await this.stdin.write(data)
      } catch (error) {
        if (!(error instanceof PipeClosed)) throw error
      } finally {
        this.stdin.close()
      }
    }
    try {
      const [, stdout, stderr, info] = await Promise.all([
        feed(),
        materialize(this.stdout),
        materialize(this.stderr),
        this.wait(),
      ])
      return { stdout, stderr, exitCode: info.exitCode ?? 1 }
    } catch (error) {
      this.terminate()
      throw error
    }
  }
}
