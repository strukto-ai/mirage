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

import { type Clock, ManualClock, SystemClock } from './clock.ts'

const MAX_SEED = Number.MAX_SAFE_INTEGER
const WORD_BITS = 32
const WORD_MASK = 0xffffffff
const TIMESTAMP_BITS = 48n
const TIMESTAMP_MASK = (1n << TIMESTAMP_BITS) - 1n
// rand_a carries the intra-millisecond counter (RFC 9562 section 6.2), seeded
// well below its maximum so a burst has room to climb, as ids.py does.
const COUNTER_MAX = 0xfff
const COUNTER_SEED_BITS = 8
const RANDOM_BITS = 62
const VERSION = 7n
const VARIANT = 0b10n
const SPLITMIX_GAMMA = 0x9e3779b97f4a7c15n
const SPLITMIX_MUL1 = 0xbf58476d1ce4e5b9n
const SPLITMIX_MUL2 = 0x94d049bb133111ebn
const UINT64_MASK = (1n << 64n) - 1n

/**
 * The millisecond and counter of the next id after `lastMs`. Two ids minted in
 * the same millisecond are ordered by the counter. A millisecond whose counter
 * is exhausted borrows the next one: on a clock that stands still or went back,
 * waiting would never end. `_stamp` in ids.py is the twin and says why.
 */
function stamp(
  lastMs: number,
  counter: number,
  nowMs: number,
  fresh: () => number,
): [number, number] {
  if (nowMs > lastMs) return [nowMs, fresh()]
  if (counter < COUNTER_MAX) return [lastMs, counter + 1]
  return [lastMs + 1, fresh()]
}

/** Lay out a UUIDv7 in canonical lowercase hyphenated form. */
function layout(timestampMs: number, counter: number, high: number, low: number): string {
  const value =
    ((BigInt(timestampMs) & TIMESTAMP_MASK) << 80n) |
    (VERSION << 76n) |
    (BigInt(counter) << 64n) |
    (VARIANT << 62n) |
    (BigInt(high) << BigInt(WORD_BITS)) |
    BigInt(low)
  const digits = value.toString(16).padStart(32, '0')
  return [
    digits.slice(0, 8),
    digits.slice(8, 12),
    digits.slice(12, 16),
    digits.slice(16, 20),
    digits.slice(20),
  ].join('-')
}

/**
 * Mint an RFC 9562 UUIDv7 in canonical lowercase hyphenated form.
 *
 * The first 48 bits are a unix-millisecond timestamp, so ids sort by
 * creation time and stay index-friendly as database primary keys; the
 * next 12 bits order ids minted inside one millisecond, and the last 62
 * bits are random. Stamped by the process's own `SystemIdSource`.
 */
export function uuid7(): string {
  return SYSTEM_IDS.uuid7()
}

/** Mint a fresh workspace id (UUIDv7). */
export function newWorkspaceId(): string {
  return uuid7()
}

/** Mint a fresh session id (UUIDv7). */
export function newSessionId(): string {
  return uuid7()
}

/** Where a workspace's generated ids and random draws come from. */
export interface IdSource {
  /** A fresh RFC 9562 UUIDv7 in canonical lowercase form. */
  uuid7(): string
  /** A uniform integer in `[0, 2**32)`. */
  randomU32(): number
}

/** The last id's millisecond and counter, which the next id follows. */
interface Floor {
  lastMs: number
  counter: number
}

const SYSTEM_FLOOR: Floor = { lastMs: -1, counter: 0 }

/**
 * Platform randomness used when no source is supplied. A UUIDv7 is stamped
 * from `clock` and ordered inside one millisecond by a counter, as
 * `SeededIdSource` orders its ids. Every source on the system clock shares the
 * process's floor, so ids minted anywhere in the process sort by when they
 * were made. A source on another clock keeps a floor of its own, so a manual
 * clock never shares one with the system clock.
 */
export class SystemIdSource implements IdSource {
  private readonly clock: Clock
  private readonly floor: Floor

  /** @param clock the clock ids are stamped from; omitted means the system clock. */
  constructor(clock?: Clock) {
    this.clock = clock ?? new SystemClock()
    this.floor = this.clock instanceof SystemClock ? SYSTEM_FLOOR : { lastMs: -1, counter: 0 }
  }

  /** A fresh UUIDv7 stamped from the source's clock. */
  uuid7(): string {
    const floor = this.floor
    const [ms, counter] = stamp(
      floor.lastMs,
      floor.counter,
      Math.floor(this.clock.now() * 1000),
      () => cryptoU32() >>> (WORD_BITS - COUNTER_SEED_BITS),
    )
    floor.lastMs = ms
    floor.counter = counter
    const high = cryptoU32() >>> (2 * WORD_BITS - RANDOM_BITS)
    return layout(ms, counter, high, cryptoU32())
  }

  /** A uniform 32-bit integer from the platform generator. */
  randomU32(): number {
    return Math.floor(Math.random() * 2 ** WORD_BITS)
  }
}

const SYSTEM_IDS = new SystemIdSource()

function cryptoU32(): number {
  return globalThis.crypto.getRandomValues(new Uint32Array(1))[0] ?? 0
}

function splitmix64(state: bigint): [bigint, bigint] {
  const next = (state + SPLITMIX_GAMMA) & UINT64_MASK
  let z = next
  z = ((z ^ (z >> 30n)) * SPLITMIX_MUL1) & UINT64_MASK
  z = ((z ^ (z >> 27n)) * SPLITMIX_MUL2) & UINT64_MASK
  return [next, z ^ (z >> 31n)]
}

function rotl(value: number, shift: number): number {
  return ((value << shift) | (value >>> (32 - shift))) >>> 0
}

/**
 * Ids and draws replayed exactly from a seed.
 *
 * Draws come from xoshiro128** (Blackman and Vigna) seeded through
 * SplitMix64, so one seed yields one sequence on every host and in both
 * languages. A UUIDv7 is stamped from `clock`, ordered inside one
 * millisecond by a counter, and borrows the next millisecond rather than
 * waiting when that counter runs out.
 */
export class SeededIdSource implements IdSource {
  private readonly clock: Clock
  private readonly state: Uint32Array
  private lastMs = -1
  private counter = 0

  /**
   * @param seed the sequence to replay, from 0 to `2**53 - 1`.
   * @param clock the clock ids are stamped from; omitted means a
   *   `ManualClock` at zero, so ids depend on the seed alone.
   */
  constructor(
    readonly seed: number,
    clock?: Clock,
  ) {
    if (!Number.isSafeInteger(seed) || seed < 0 || seed > MAX_SEED) {
      throw new RangeError(`seed must be in [0, 2**53 - 1]: ${String(seed)}`)
    }
    this.clock = clock ?? new ManualClock()
    const [state, first] = splitmix64(BigInt(seed))
    const [, second] = splitmix64(state)
    this.state = Uint32Array.of(
      Number(first >> BigInt(WORD_BITS)),
      Number(first & BigInt(WORD_MASK)),
      Number(second >> BigInt(WORD_BITS)),
      Number(second & BigInt(WORD_MASK)),
    )
  }

  /** The next 32-bit draw of the seeded sequence. */
  randomU32(): number {
    const s = this.state
    const s0 = s[0] ?? 0
    const s1 = s[1] ?? 0
    const s2 = (s[2] ?? 0) ^ s0
    const s3 = (s[3] ?? 0) ^ s1
    s[0] = s0 ^ s3
    s[1] = s1 ^ s2
    s[2] = s2 ^ (s1 << 9)
    s[3] = rotl(s3 >>> 0, 11)
    return Math.imul(rotl(Math.imul(s1, 5) >>> 0, 7), 9) >>> 0
  }

  /** The next UUIDv7 of the seeded sequence, stamped from the clock. */
  uuid7(): string {
    const [ms, counter] = stamp(
      this.lastMs,
      this.counter,
      Math.floor(this.clock.now() * 1000),
      () => this.randomU32() >>> (WORD_BITS - COUNTER_SEED_BITS),
    )
    this.lastMs = ms
    this.counter = counter
    const high = this.randomU32() >>> (2 * WORD_BITS - RANDOM_BITS)
    return layout(this.lastMs, this.counter, high, this.randomU32())
  }
}

/**
 * A uniform bigint in `[0, limit)` drawn from `ids`.
 *
 * Whole 32-bit words are drawn, most significant first, the top bits of the
 * limit's own bit length kept, and a value past the limit drawn again, which
 * discards at most half the draws. `random_below` in ids.py is the twin and
 * draws the same words for the same limit.
 */
export function randomBelowBig(ids: IdSource, limit: bigint): bigint {
  if (limit <= 0n) throw new RangeError(`limit must be positive: ${String(limit)}`)
  const bits = limit.toString(2).length
  const words = Math.ceil(bits / WORD_BITS)
  const shift = BigInt(words * WORD_BITS - bits)
  for (;;) {
    let drawn = 0n
    for (let i = 0; i < words; i++) {
      drawn = (drawn << BigInt(WORD_BITS)) | BigInt(ids.randomU32())
    }
    const value = drawn >> shift
    if (value < limit) return value
  }
}

/**
 * A uniform integer in `[0, limit)` drawn from `ids`, as `randomBelowBig`
 * draws it; a limit within one word skips the bigint arithmetic.
 */
export function randomBelow(ids: IdSource, limit: number): number {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new RangeError(`limit must be a positive safe integer: ${String(limit)}`)
  }
  if (limit > WORD_MASK) return Number(randomBelowBig(ids, BigInt(limit)))
  const shift = Math.clz32(limit)
  for (;;) {
    const value = Math.floor(ids.randomU32() / 2 ** shift)
    if (value < limit) return value
  }
}

/** Permute `items` in place, uniformly, with draws from `ids`. */
export function shuffle(ids: IdSource, items: unknown[]): void {
  for (let i = items.length - 1; i > 0; i--) {
    const j = randomBelow(ids, i + 1)
    const picked = items[j]
    items[j] = items[i]
    items[i] = picked
  }
}
