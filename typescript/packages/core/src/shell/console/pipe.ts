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

import { BytePipe, CAPACITY } from '../../io/pipe.ts'
import { JobConsole } from './job_console.ts'
import { Channel } from './types.ts'

/** Route a shell's piped channels through the shared bounded byte pipe. */
export class PipeConsole extends JobConsole {
  private readonly pipe: BytePipe

  constructor(
    private readonly pipeStderr = false,
    bufferBytes = CAPACITY,
  ) {
    super()
    this.pipe = new BytePipe(bufferBytes)
  }

  override async emit(channel: Channel, data: Uint8Array): Promise<void> {
    if (channel !== Channel.STDOUT && !this.pipeStderr) await super.emit(channel, data)
    else await this.pipe.write(data)
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

  closeReader(): void {
    this.pipe.closeReader()
  }

  release(): void {
    this.pipe.release()
  }

  stream(): AsyncGenerator<Uint8Array> {
    return this.pipe.stream()
  }
}
