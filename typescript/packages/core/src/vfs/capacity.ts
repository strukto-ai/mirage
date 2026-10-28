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

import { edquot } from '../errors/fs.ts'
import { chunks } from '../io/cooperative.ts'
import type { ByteSource } from '../io/types.ts'
import { type CapacityResult, CapacityState, type PathSpec } from '../types.ts'
import { parseLimit } from '../utils/size.ts'
import { VFSConfigError } from './errors.ts'

/** The bytes at a path, a directory's included; 0 for none. */
export type SizeOf = (path: PathSpec) => Promise<number>
/** The bytes the whole store holds. */
export type CountAll = () => Promise<number>

/**
 * One store's capacity and the bytes counted against it.
 *
 * `used` is null until the store is counted. `pending` holds bytes a stream
 * or an awaiting write admitted and has not landed yet. `active` holds the
 * writes in flight. Every method but `counted` is
 * synchronous, so a check and the change it guards run as one step on the
 * one thread, which is what makes parallel writers safe without a lock. Two
 * writes in flight on overlapping paths (a file and its folder) can both
 * measure the same bytes, so they lose the credit for the bytes they replace
 * and mark the count for a recount, which waits until no write is in flight. The count lives in this object: another
 * process, or another VFS on the same disk folder, Redis prefix or OPFS
 * directory, counts on its own, so together they can pass the limit.
 * Mirrors Python's `StorageUsage`.
 */
export class StorageUsage {
  pending = 0
  readonly active: Charge[] = []
  dirty = false
  private counting: Promise<void> | null = null

  constructor(
    readonly limit: number,
    public used: number | null = null,
  ) {}

  /** Count the store when it is uncounted, or marked for a recount and no
   * write is in flight; parallel callers wait on one count. */
  async counted(count: CountAll): Promise<void> {
    while (
      this.used === null ||
      this.counting !== null ||
      (this.dirty && this.active.length === 0)
    ) {
      if (this.counting === null) {
        this.dirty = false
        this.counting = this.count(count)
      }
      await this.counting
    }
  }

  private async count(count: CountAll): Promise<void> {
    try {
      this.used = await count()
    } catch (err) {
      this.dirty = true
      throw err
    } finally {
      this.counting = null
    }
  }

  /** Count the store again once no write is in flight, as bytes written
   * past mirage (a native program on a disk folder) went uncounted. */
  stale(): void {
    this.dirty = true
  }

  /** Mark a write in flight; one overlapping another in flight takes both
   * off their credit and marks the count for a recount. */
  enter(held: Charge): void {
    for (const other of this.active) {
      if (overlaps(other.path, held.path)) other.contended = held.contended = this.dirty = true
    }
    this.active.push(held)
  }

  /** Mark a write done. */
  leave(held: Charge): void {
    this.active.splice(this.active.indexOf(held), 1)
  }

  /** Throw `edquot(path)` when positive growth would pass the limit;
   * reaching it exactly passes. */
  admit(path: PathSpec, growth: number): void {
    if (growth <= 0) return
    if (this.used === null) throw new Error('an uncounted usage cannot admit growth')
    if (this.used + this.pending + growth > this.limit) throw edquot(path)
  }

  /** Admit `size` and keep it in `pending` until it lands. */
  hold(path: PathSpec, size: number): void {
    this.admit(path, size)
    this.pending += size
  }

  /** Take `held` out of `pending` and add the measured `delta`. */
  land(held: number, delta: number): void {
    this.pending -= held
    if (this.used !== null) this.used += delta
  }

  /** df's QUOTA row: total is the limit, available never below 0. */
  report(): CapacityResult {
    if (this.used === null) return { state: CapacityState.UNKNOWN }
    return {
      state: CapacityState.QUOTA,
      total: this.limit,
      used: this.used,
      available: Math.max(this.limit - this.used, 0),
    }
  }
}

function overlaps(a: PathSpec, b: PathSpec): boolean {
  const x = a.vfsPath.replace(/\/+$/, '')
  const y = b.vfsPath.replace(/\/+$/, '')
  return x === y || x.startsWith(y + '/') || y.startsWith(x + '/')
}

/**
 * A backend's usage for its `capacity` setting; null for no cap. `used` is
 * the bytes it starts with when the backend knows them, as an empty RAM
 * store does. Mirrors Python's `storage_usage`.
 *
 * @throws VFSConfigError when the setting is not a size.
 */
export function storageUsage(
  name: string,
  capacity: number | string | null | undefined,
  used: number | null = null,
): StorageUsage | null {
  if (capacity === undefined || capacity === null) return null
  let limit: number
  try {
    limit = parseLimit(capacity, 'capacity')
  } catch (err) {
    throw new VFSConfigError(`${name}: ${(err as Error).message}`, { cause: err })
  }
  return new StorageUsage(limit, used)
}

/**
 * What one write reserves against a counted store, and the bytes it held so
 * far; inert for an uncapped store. A replacement is credited with the bytes
 * it replaces until another write overlaps it (`contended`), as that write
 * may move those bytes elsewhere. Mirrors Python's `Charge`.
 */
export class Charge {
  held = 0
  written = 0
  contended = false

  constructor(
    readonly usage: StorageUsage | null,
    readonly path: PathSpec,
    public before = 0,
  ) {}

  /** Reserve `size` more bytes, or throw EDQUOT. */
  hold(size: number): void {
    if (this.usage === null || size <= 0) return
    this.usage.hold(this.path, size)
    this.held += size
  }

  /** The length the operand may reach within what this charge holds and is
   * credited with. */
  get reserved(): number {
    return (this.contended ? 0 : this.before) + this.held
  }

  /** Reserve what growing the operand to `size` bytes adds past what this
   * charge already holds. */
  growTo(size: number): void {
    this.hold(size - this.reserved)
  }

  /** `data`, each chunk reserved as the writer takes it. With `append`
   * false, a replacement reserves only what passes the bytes it replaces. */
  stream(data: ByteSource, append = false): ByteSource {
    if (this.usage === null) return data
    if (data instanceof Uint8Array) {
      this.take(data.byteLength, append)
      return data
    }
    return this.held_(data, append)
  }

  private take(size: number, append: boolean): void {
    this.written += size
    if (append) this.hold(size)
    else this.growTo(this.written)
  }

  private async *held_(data: ByteSource, append: boolean): AsyncIterable<Uint8Array> {
    for await (const chunk of chunks(data)) {
      this.take(chunk.byteLength, append)
      yield chunk
    }
  }
}

/**
 * Reserve before a write's bytes go and land what it really changed. The
 * reservation is checked and taken in one synchronous step, so parallel
 * writers can never pass the store's capacity together. After the write,
 * however it ended, the operand is measured again and the change lands; one
 * that overlapped another in flight marks the count for a recount. An
 * uncapped store gets an inert charge and measures nothing. Mirrors Python's
 * `charge`.
 */
export async function charge<T>(
  usage: StorageUsage | null,
  path: PathSpec,
  sizeOf: SizeOf,
  count: CountAll,
  write: (held: Charge) => Promise<T>,
): Promise<T> {
  if (usage === null) return write(new Charge(null, path))
  await usage.counted(count)
  const held = new Charge(usage, path)
  usage.enter(held)
  try {
    const before = (held.before = await sizeOf(path))
    const settle = async (): Promise<void> => {
      let after: number
      try {
        after = await sizeOf(path)
      } catch (err) {
        usage.land(held.held, 0)
        usage.stale()
        throw err
      }
      usage.land(held.held, after - before)
    }
    let result: T
    try {
      result = await write(held)
    } catch (err) {
      await settle()
      throw err
    }
    await settle()
    return result
  } finally {
    usage.leave(held)
  }
}
