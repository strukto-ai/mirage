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

import { PipeClosed } from '@struktoai/mirage-core/io/errors'
import { CAPACITY, BytePipe } from '@struktoai/mirage-core/io/pipe'

/** An upload backed by the same bounded byte pipe as process stdin. */
export class UploadStdin implements AsyncIterable<Uint8Array> {
  private readonly pipe: BytePipe
  private discarding = false

  constructor(capacity = CAPACITY) {
    this.pipe = new BytePipe(capacity)
  }

  /** Accept bytes in bounded plain Uint8Array chunks, waiting for capacity. */
  async feed(data: Uint8Array): Promise<void> {
    if (this.discarding) return
    try {
      await this.pipe.write(data)
    } catch (error) {
      if (!(error instanceof PipeClosed) || !this.pipe.closedReader) throw error
    }
  }

  /** Mark the end of the upload. */
  close(): void {
    this.pipe.end()
  }

  /** Release readers and feeders, dropping unread bytes. */
  discard(): void {
    this.discarding = true
    this.pipe.closeReader()
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
    try {
      yield* this.pipe.stream()
    } finally {
      this.discard()
    }
  }
}
