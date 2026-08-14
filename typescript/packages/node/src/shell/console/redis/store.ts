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

import type { RedisClientType } from 'redis'
import {
  Channel,
  type ConsoleChunk,
  type ConsoleStore,
  type ReadResult,
} from '@struktoai/mirage-core'
import { loadOptionalPeer } from '../../../optional_peer.ts'
import { APPEND_LUA, POLL_MS } from './constants.ts'

interface StreamEntry {
  id: { toString: () => string }
  message: Partial<Record<string, Buffer>>
}

export interface RedisConsoleStoreOptions {
  url?: string
  keyPrefix?: string
  /** Expire the keys this long after the last append; absent keeps them. */
  ttlSeconds?: number
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

/**
 * Console storage on a Redis stream, for readers in other processes.
 *
 * One stream per job: chunk seq maps to stream id `(seq+1)-0`, with the
 * channel, payload and timestamp as entry fields (`c`/`d`/`t`). The
 * job's process appends through its store instance; a reader anywhere
 * else attaches its own instance on the same keyPrefix and follows
 * live, which is what RAM cannot offer. The schema matches the Python
 * RedisConsoleStore byte for byte, so the reader does not have to be
 * the writer's language.
 *
 * The job owns its keys: a factory must hand every job a prefix nothing
 * else has written, because a reused stream replays the previous job's
 * chunks, ending chunk included. `keyPrefix` stays public because it is
 * the console's address: an embedder reads it off a job's store and
 * hands it to the process that should attach.
 *
 * The ending chunk is terminal in the store itself, not only in this
 * process: the append script refuses any append once a CONTROL chunk
 * landed, so an emit that raced a kill past `JobConsole`'s local guard
 * is dropped server-side instead of landing after the ending.
 *
 * `wait` polls the seq counter rather than blocking server-side the way
 * Python's XREAD BLOCK does: node-redis serializes commands on one
 * connection, so a blocking read would wedge the job's own appends
 * behind it, and a second connection costs more than a short poll.
 * There is no retention trim, so readFrom never reports a truncated
 * cursor; retention is bounded by `ttlSeconds` instead, refreshed on
 * every append, so a console expires that long after its job's last
 * write.
 */
export class RedisConsoleStore implements ConsoleStore {
  readonly url: string
  readonly keyPrefix: string
  private readonly streamKey: string
  private readonly counterKey: string
  private readonly endedKey: string
  private readonly ttlSeconds: number
  private clientPromise: Promise<RedisClientType> | null = null
  private isClosed = false

  constructor(options: RedisConsoleStoreOptions = {}) {
    this.url = options.url ?? 'redis://localhost:6379/0'
    this.keyPrefix = options.keyPrefix ?? 'mirage:console:'
    this.streamKey = `${this.keyPrefix}stream`
    this.counterKey = `${this.keyPrefix}seq`
    this.endedKey = `${this.keyPrefix}ended`
    this.ttlSeconds = options.ttlSeconds ?? 0
  }

  get closed(): boolean {
    return this.isClosed
  }

  private async client(): Promise<RedisClientType> {
    this.clientPromise ??= (async () => {
      const mod = await loadOptionalPeer(
        () =>
          import('redis') as unknown as Promise<{
            createClient: (o: { url: string }) => RedisClientType
          }>,
        { feature: 'RedisConsoleStore', packageName: 'redis' },
      )
      const c = mod.createClient({
        url: this.url,
        socket: { reconnectStrategy: false },
      } as Parameters<typeof mod.createClient>[0])
      await c.connect()
      return c
    })()
    return this.clientPromise
  }

  /**
   * Append one chunk, atomically against the console's ending.
   *
   * A dropped append (the console already ended) reports the last real
   * chunk's seq; `JobConsole.emit` ignores the return and the drop is
   * exactly its documented after-the-ending semantics.
   */
  async append(channel: Channel, data: Uint8Array): Promise<ConsoleChunk> {
    const c = await this.client()
    const ts = Date.now() / 1000
    const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
    const count = (await c.eval(APPEND_LUA, {
      keys: [this.streamKey, this.counterKey, this.endedKey],
      arguments: [
        channel,
        buf,
        String(ts),
        channel === Channel.CONTROL ? '1' : '0',
        String(this.ttlSeconds),
      ],
    })) as number
    return { seq: count - 1, ts, channel, data }
  }

  async readFrom(seq: number, limit?: number): Promise<ReadResult> {
    const c = await this.client()
    const mod = (await import('redis')) as unknown as {
      RESP_TYPES: { readonly BLOB_STRING: number }
    }
    const mapping: Record<number, unknown> = { [mod.RESP_TYPES.BLOB_STRING]: Buffer }
    const typed = c as unknown as {
      withTypeMapping: (m: Record<number, unknown>) => {
        xRange: (
          key: string,
          start: string,
          end: string,
          options?: { COUNT: number },
        ) => Promise<StreamEntry[]>
      }
    }
    const entries = await typed
      .withTypeMapping(mapping)
      .xRange(
        this.streamKey,
        `${(seq + 1).toString()}-0`,
        '+',
        limit === undefined ? undefined : { COUNT: limit },
      )
    const chunks = entries.map((entry) => this.chunk(entry))
    const first = chunks[0]
    const last = chunks[chunks.length - 1]
    if (first !== undefined && last !== undefined) {
      return [chunks, last.seq + 1, first.seq > seq]
    }
    // An empty window still clamps the cursor the way RAM does, so a
    // follower armed past the end waits at the next real seq.
    const raw = await c.get(this.counterKey)
    const total = raw === null ? 0 : Number(raw)
    return [[], Math.min(seq, total), false]
  }

  async wait(seq: number): Promise<void> {
    // Checked before touching the client: close() nulls the promise,
    // and a wait arriving later must not reconnect a discarded store.
    if (this.isClosed) return
    const c = await this.client()
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- close() flips it across awaits
    while (!this.isClosed) {
      let raw: string | null
      try {
        raw = await c.get(this.counterKey)
      } catch (err) {
        // close() tore down the client under a parked reader; that is
        // the documented way a wait ends early.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- close() flips it across awaits
        if (this.isClosed) return
        throw err
      }
      if (raw !== null && Number(raw) > seq) return
      await sleep(POLL_MS)
    }
  }

  async close(): Promise<void> {
    // Idempotent, and the flag flips before the quit so a parked wait
    // that wakes mid-teardown returns instead of re-polling.
    this.isClosed = true
    if (this.clientPromise === null) return
    const pending = this.clientPromise
    this.clientPromise = null
    const c = await pending
    await c.quit()
  }

  /** Delete the console's keys (test and integ teardown only). */
  async clear(): Promise<void> {
    const c = await this.client()
    await c.del([this.streamKey, this.counterKey, this.endedKey])
  }

  private chunk(entry: StreamEntry): ConsoleChunk {
    return {
      seq: Number(entry.id.toString().split('-')[0]) - 1,
      ts: Number(entry.message.t?.toString() ?? '0'),
      channel: (entry.message.c?.toString() ?? 'stdout') as Channel,
      data: new Uint8Array(entry.message.d ?? Buffer.alloc(0)),
    }
  }
}
