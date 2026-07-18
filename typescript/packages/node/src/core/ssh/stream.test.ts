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

import { Readable } from 'node:stream'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { PathSpec } from '@struktoai/mirage-core'
import type { ReadStream, SFTPWrapper } from 'ssh2'
import { SSHAccessor } from '../../accessor/ssh.ts'
import { makeFakeAccessor } from './_test_utils.ts'
import { rangeRead, stream } from './stream.ts'

class DelayedCloseStream extends Readable {
  private sent = false
  private closeCallback: ((error?: Error | null) => void) | null = null
  private closeError: Error | null = null

  constructor() {
    super({ emitClose: false, autoDestroy: false })
    this.on('end', this.destroyOnEnd.bind(this))
  }

  private destroyOnEnd(): void {
    this.destroy()
  }

  override _read(): void {
    if (this.sent) return
    this.sent = true
    this.push(Buffer.from('x'))
    this.push(null)
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.closeError = error
    this.closeCallback = callback
  }

  releaseClose(): void {
    const callback = this.closeCallback
    if (callback === null) throw new Error('stream close was not requested')
    this.closeCallback = null
    callback(this.closeError)
    if (this.closeError === null) this.emit('close')
  }
}

class DelayedCloseSftp {
  constructor(private readonly rs: ReadStream) {}

  createReadStream(): ReadStream {
    return this.rs
  }
}

class DelayedCloseAccessor extends SSHAccessor {
  private readonly fakeSftp: SFTPWrapper

  constructor(rs: ReadStream) {
    super({ host: 'fake' })
    this.fakeSftp = new DelayedCloseSftp(rs) as unknown as SFTPWrapper
  }

  override sftp(): Promise<SFTPWrapper> {
    return Promise.resolve(this.fakeSftp)
  }
}

function markSettled(): boolean {
  return true
}

async function markPending(): Promise<boolean> {
  await nextTurn()
  return false
}

function spec(p: string): PathSpec {
  return PathSpec.fromStrPath(p)
}

describe('core/ssh/stream', () => {
  it('yields all bytes', async () => {
    const accessor = makeFakeAccessor({
      files: new Map([['/x', { data: new TextEncoder().encode('hello stream') }]]),
      dirs: new Map([['/', {}]]),
    })
    const chunks: Uint8Array[] = []
    for await (const c of stream(accessor, spec('/x'))) chunks.push(c)
    const decoded = chunks.map((c) => new TextDecoder().decode(c)).join('')
    expect(decoded).toBe('hello stream')
  })

  it('throws ENOENT on missing', async () => {
    const accessor = makeFakeAccessor({
      files: new Map(),
      dirs: new Map([['/', {}]]),
    })
    const it = stream(accessor, spec('/missing'))
    await expect(it[Symbol.asyncIterator]().next()).rejects.toBeDefined()
  })

  it('waits for the remote handle to close after reading ends', async () => {
    const rs = new DelayedCloseStream()
    const accessor = new DelayedCloseAccessor(rs as unknown as ReadStream)
    const iterator = stream(accessor, spec('/x'))[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({ done: false })
    const done = iterator.next()
    const settledBeforeClose = await Promise.race([done.then(markSettled), markPending()])
    rs.releaseClose()
    await expect(done).resolves.toEqual({ done: true, value: undefined })
    expect(settledBeforeClose).toBe(false)
  })
})

describe('core/ssh/stream.rangeRead', () => {
  it('returns the byte slice [start, end)', async () => {
    const accessor = makeFakeAccessor({
      files: new Map([['/x', { data: new TextEncoder().encode('abcdefghij') }]]),
      dirs: new Map([['/', {}]]),
    })
    const out = await rangeRead(accessor, spec('/x'), 2, 6)
    expect(new TextDecoder().decode(out)).toBe('cdef')
  })
})
