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

import { mkdtemp, open, rm, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CHUNK_SIZE } from '@struktoai/mirage-core/io/cooperative'
import { CAPACITY } from '@struktoai/mirage-core/io/pipe'
import { MAX_STDIN_BYTES } from './constants.ts'
import { MultipartError } from './multipart.ts'
import { KeyLock } from '@struktoai/mirage-core/cache/lock'

/** Keep receiving disconnects while unread stdin spills beyond bounded memory. */
export class UploadStdin implements AsyncIterable<Uint8Array> {
  private readonly lock = new KeyLock()
  private chunks: Uint8Array[] = []
  private buffered = 0
  private file: FileHandle | undefined
  private directory: string | undefined
  private written = 0
  private read = 0
  private ended = false
  private discarding = false
  private wake: (() => void) | undefined
  private received = 0
  error: unknown

  constructor(
    private readonly capacity = CAPACITY,
    private readonly limit = MAX_STDIN_BYTES,
  ) {}

  async feed(data: Uint8Array): Promise<void> {
    for (let offset = 0; offset < data.length; offset += CHUNK_SIZE) {
      await this.lock.withLock('input', async () => {
        if (this.discarding) return
        const chunk = new Uint8Array(data.subarray(offset, offset + CHUNK_SIZE))
        this.received += chunk.length
        if (this.received > this.limit) throw new MultipartError(413, 'stdin part too large')
        if (this.file === undefined && this.buffered + chunk.length <= this.capacity) {
          this.chunks.push(chunk)
          this.buffered += chunk.length
        } else {
          if (this.file === undefined) {
            this.directory = await mkdtemp(join(tmpdir(), 'mirage-stdin-'))
            this.file = await open(join(this.directory, 'data'), 'w+')
          }
          let at = 0
          while (at < chunk.length) {
            const { bytesWritten } = await this.file.write(
              chunk,
              at,
              chunk.length - at,
              this.written,
            )
            at += bytesWritten
            this.written += bytesWritten
          }
        }
        this.wake?.()
      })
      if (this.discarding) return
    }
  }

  private isDiscarding(): boolean {
    return this.discarding
  }

  close(): void {
    this.ended = true
    this.wake?.()
  }

  /** Record why the upload failed, then drop unread bytes. */
  async fail(error: unknown): Promise<void> {
    this.error = error
    await this.discard()
  }

  async discard(): Promise<void> {
    this.discarding = true
    this.wake?.()
    await this.lock.withLock('input', async () => {
      this.chunks = []
      this.buffered = 0
      await this.file?.close()
      this.file = undefined
      if (this.directory !== undefined) {
        await rm(this.directory, { recursive: true, force: true })
        this.directory = undefined
      }
    })
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
    try {
      while (!this.discarding) {
        let changed!: Promise<void>
        const data = await this.lock.withLock('input', async () => {
          const chunk = this.chunks.shift()
          if (chunk !== undefined) {
            this.buffered -= chunk.length
            return chunk
          }
          if (this.file !== undefined && this.read < this.written) {
            const bytes = new Uint8Array(Math.min(CHUNK_SIZE, this.written - this.read))
            const { bytesRead } = await this.file.read(bytes, 0, bytes.length, this.read)
            this.read += bytesRead
            if (this.read === this.written) {
              await this.file.truncate(0)
              this.read = this.written = 0
            }
            return bytes.subarray(0, bytesRead)
          }
          changed = new Promise((resolve) => {
            this.wake = resolve
          })
          return undefined
        })
        if (data !== undefined) yield data
        else if (this.ended || this.isDiscarding()) return
        else await changed
      }
    } finally {
      await this.discard()
    }
  }
}
