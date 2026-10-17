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

import { ByteSpool } from '../io/spool.ts'
import { chunks } from '../io/cooperative.ts'
import { OutputStream } from '../io/stream.ts'
import type { ByteSource } from '../io/types.ts'
import { FD_BOTH, FD_CLOSE } from './constants.ts'
import { SharedInput } from '../io/async_line_iterator.ts'
import { createAsyncContext } from '../utils/async_context.ts'
import { type Channel, JobConsole, type OwnedStream, Terminal } from './console/index.ts'
import type { PathSpec } from '../types.ts'
import { ebadf } from '../errors/fs.ts'
import { RedirectKind, type Redirect } from './types.ts'
import { encodeText } from './bytes.ts'

/**
 * The first descriptor outside the signed 32-bit range, or null. Both slots count: the
 * descriptor a redirect claims (`3>f`, `3<f`, `3>&1`, `3>&-`) and the one
 * it duplicates from (`>&3`, `<&3`, `2>&3`). `&>`'s FD_BOTH and `>&-`'s
 * FD_CLOSE are the two sentinels the parser spells with -1, and neither is
 * a descriptor.
 */
export function unsupportedDescriptor(redirects: readonly Redirect[]): number | null {
  for (const r of redirects) {
    // An ambiguous redirect (`3>&word`) is skipped: bash refuses it in its
    // own words before it judges the descriptor, and so does the installer.
    if (r.kind === RedirectKind.AMBIGUOUS) continue
    if (!(r.fd >= 0 && r.fd < 2 ** 31) && r.fd !== FD_BOTH) return r.fd
    if (
      typeof r.target === 'number' &&
      !(r.target >= 0 && r.target < 2 ** 31) &&
      r.target !== FD_CLOSE
    ) {
      return r.target
    }
  }
  return null
}

/** Bash's error for a closed descriptor, without the line-number prefix. */
export function badDescriptorLine(fd: number): Uint8Array {
  return encodeText(`${String(fd)}: Bad file descriptor\n`)
}

/**
 * Standard input that fails on its first read with EBADF. bash opens a
 * command whose stdin is closed (`<&-`) or duplicated from a write-only
 * descriptor (`0<&1`) all the same; the descriptor exists, and only a
 * read of it fails. A command that never reads (`true 0<&1`) succeeds,
 * and one that does reports `<cmd>: -: Bad file descriptor` and exits 1,
 * which is what the chokepoint renders from the error this throws.
 */
export function unreadableStdin(): AsyncIterable<Uint8Array> {
  return {
    [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(ebadf('-')) }),
  }
}

export class FileDescription {
  opened = false
  offset = 0
  source: FileInput | null = null
  emit: ((data: Uint8Array) => Promise<void>) | null = null
  /** Settles when the last write through this description has. */
  writing: Promise<void> = Promise.resolve()
  constructor(
    readonly scope: PathSpec,
    readonly append = false,
    readonly pipe = false,
  ) {}
}

export class FileInput extends SharedInput {
  constructor(
    readonly description: FileDescription,
    data: ByteSource,
  ) {
    super(data, null, true)
  }
  override dup(): this {
    return this
  }
}

/**
 * Who a stream a level was given belongs to: a redirect level's recorder,
 * or a session, whose own line its terminal streams are. Mirrors Python's
 * StreamOwner.
 */
export type StreamOwner = symbol

/**
 * The stdout or stderr a level was given rather than opened. A descriptor
 * copied from it (`3>&1`, `exec 3>&1`) keeps naming it after the level
 * rebinds its own (`3>&1 >f`), as bash's copy keeps the open file
 * description. Mirrors Python's Inherited.
 */
export class Inherited {
  constructor(
    readonly owner: StreamOwner,
    readonly channel: Channel,
  ) {}
}

/**
 * What one level's command wrote, in order, for the level to route. A chunk
 * on a channel goes through the level's descriptor table; one written to a
 * stream another level owns stays in place on its way up to that level, so it
 * lands among the bytes written around it. Mirrors Python's Recorder.
 */
export class Recorder extends JobConsole {
  readonly chunks: [Channel | Inherited, number, number][] = []
  readonly owner: StreamOwner = Symbol('recorder')
  private storage = new ByteSpool()
  private writing = Promise.resolve()
  private pending = 0
  /** Whether a write is under way or recorded bytes wait to be taken. Mirrors Python's busy. */
  get busy(): boolean {
    return this.pending > 0 || this.chunks.length > 0
  }
  private async record(key: Channel | Inherited, data: Uint8Array): Promise<void> {
    this.pending++
    const before = this.writing
    let done = (): void => undefined
    this.writing = new Promise((resolve) => {
      done = resolve
    })
    try {
      await before
      const start = this.storage.size
      await this.storage.append(data)
      const last = this.chunks.at(-1)
      if (last?.[0] === key) last[2] += data.length
      else this.chunks.push([key, start, data.length])
    } finally {
      this.pending--
      done()
    }
  }
  override async emit(channel: Channel, data: Uint8Array): Promise<void> {
    await this.record(channel, data)
  }
  override async emitTo(stream: OwnedStream, data: Uint8Array): Promise<void> {
    await this.record(stream instanceof Inherited ? stream : stream.channel, data)
  }
  /**
   * Drop what was recorded and never taken, for a level that failed before
   * it routed its output; a late job write starts afresh. Mirrors Python.
   */
  override async close(): Promise<void> {
    await this.writing
    this.chunks.splice(0)
    const storage = this.storage
    this.storage = new ByteSpool()
    try {
      await storage.close()
    } finally {
      await super.close()
    }
  }
  async take(): Promise<[Channel | Inherited, ByteSource][]> {
    await this.writing
    const entries = this.chunks.splice(0),
      storage = this.storage
    this.storage = new ByteSpool()
    if (storage.size <= storage.memoryLimit) {
      const data = await storage.read(0, storage.size)
      await storage.close()
      return entries.map(([key, start, size]) => [key, data.slice(start, start + size)])
    }
    let remaining = entries.length
    const release = async (): Promise<void> => {
      if (--remaining === 0) await storage.close()
    }
    return entries.map(([key, start, size]) => [
      key,
      new OutputStream(storage.stream(start, size), release),
    ])
  }
}

/**
 * The recorder of the innermost level running a command, for a level whose
 * output is a value (a substitution's) to send another level's stream bytes
 * toward it. Mirrors Python's ENCLOSING.
 */
export const ENCLOSING = createAsyncContext<Recorder>()

/**
 * Send bytes written to a stream another level owns toward it: up through
 * the sink, or the enclosing level's recorder when the level returns its
 * output as a value or writes to a terminal of its own (a line's, a
 * substitution's), which owns no stream above it. A console that keeps no
 * streams takes them on their channel. False when there is nowhere above.
 * Mirrors Python's deliver.
 */
export async function deliver(
  sink: JobConsole | null,
  stream: Inherited,
  data: ByteSource,
): Promise<boolean> {
  const target =
    sink !== null && !(sink instanceof Terminal) ? sink : (ENCLOSING.getStore() ?? null)
  if (target === null) return false
  for await (const part of chunks(data)) await target.emitTo(stream, part)
  return true
}

export interface Descriptor {
  readonly identity: string
  readonly append: boolean
  readonly source: SharedInput | null
  readonly file: FileDescription | null
  readonly stream?: Inherited | null
}
