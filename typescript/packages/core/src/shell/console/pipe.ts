// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import { checkMemory } from '../../io/memory.ts'
import { BytePipe, CAPACITY } from '../../io/pipe.ts'
import { JobConsole } from './job_console.ts'
import { Channel } from './types.ts'

/**
 * Route a shell's piped channels through the shared bounded byte pipe.
 * Stderr that is not piped goes on to `errors` as it is written, as a
 * pipeline stage's goes to the shell's own fd 2, or is kept here, checked
 * against the workspace's memory, when there is none. Mirrors Python's
 * `PipeConsole`.
 */
export class PipeConsole extends JobConsole {
  private readonly pipe: BytePipe
  private muted = false
  private held = 0

  constructor(
    private readonly pipeStderr = false,
    bufferBytes = CAPACITY,
    gate: (() => Promise<void> | null) | null = null,
    private readonly errors?: JobConsole,
  ) {
    super()
    this.pipe = new BytePipe(bufferBytes, false, gate)
  }

  override async emit(channel: Channel, data: Uint8Array): Promise<void> {
    if (channel === Channel.STDERR && !this.pipeStderr && this.errors !== undefined) {
      await this.errors.emit(channel, data)
    } else if (channel !== Channel.STDOUT && !this.pipeStderr) {
      if (channel === Channel.STDERR) {
        this.held += data.byteLength
        checkMemory(this.held)
      }
      await super.emit(channel, data)
    } else if (!this.muted) {
      await this.pipe.write(data).catch((error: unknown) => {
        if (!this.muted) throw error
        console.debug(`console pipe: a muted write is dropped: ${String(error)}`)
      })
    }
  }

  override pipeFor(channel: Channel): BytePipe | null {
    return channel === Channel.STDOUT || this.pipeStderr ? this.pipe : null
  }

  async drain(): Promise<void> {
    await this.pipe.drain()
  }

  get closedReader(): boolean {
    return this.pipe.closedReader
  }

  end(error?: unknown): void {
    this.pipe.end(error)
  }

  /**
   * End the reader's stream here and drop what is piped after, unrefused: a
   * stopped JS run goes on past its abort, where a stopped process writes
   * nothing more, and a refused write would end it as a broken pipe instead.
   */
  mute(): void {
    this.muted = true
    this.pipe.end()
  }

  closeReader(): void {
    this.pipe.closeReader()
  }

  release(): void {
    this.pipe.release()
  }

  stream(): AsyncGenerator<Uint8Array> {
    return this.pipe.stream(true)
  }
}
