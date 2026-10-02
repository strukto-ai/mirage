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

import { type MockInstance, vi } from 'vitest'
import type { FileStat, PathSpec } from '../types.ts'
import { type CacheInvalidator, runWithCacheManager } from './context.ts'
import type { WriteReceipt } from './types.ts'

/**
 * Move performance.now() forward for the listing window without freezing it.
 *
 * The rate limiter and the yield budget read the same clock, so a frozen one
 * stalls them; this keeps it running and adds an offset. Restore with
 * vi.restoreAllMocks() or the returned spy.
 */
export function shiftPerformanceNow(): {
  advance: (ms: number) => void
  spy: MockInstance<() => number>
} {
  const real = performance.now.bind(performance)
  let offset = 0
  const spy = vi.spyOn(performance, 'now').mockImplementation(() => real() + offset)
  return {
    advance: (ms) => {
      offset += ms
    },
    spy,
  }
}

export interface Settled {
  path: string
  data: string
  receipt: WriteReceipt | null
  generation: number | null
}

/**
 * A cache manager that records what a core mutator reports. `generation` is
 * fixed, so a writer that notes it before the upload hands the same number
 * to `settleAfterWrite`.
 */
export class SettleRecorder implements CacheInvalidator {
  generation = 5
  readonly settled: Settled[] = []
  readonly writes: string[] = []

  settleAfterWrite(
    path: PathSpec,
    data: Uint8Array,
    receipt: WriteReceipt | null,
    generation: number | null,
  ): Promise<void> {
    this.settled.push({
      path: path.virtual,
      data: new TextDecoder().decode(data),
      receipt,
      generation,
    })
    return Promise.resolve()
  }

  invalidateAfterWrite(path: string | PathSpec): Promise<void> {
    this.writes.push(typeof path === 'string' ? path : path.virtual)
    return Promise.resolve()
  }

  invalidateAfterUnlink(): Promise<void> {
    return Promise.resolve()
  }

  invalidateSubtree(): Promise<void> {
    return Promise.resolve()
  }

  invalidateAncestors(): Promise<void> {
    return Promise.resolve()
  }

  cachedBytes(): Promise<Uint8Array | null> {
    return Promise.resolve(null)
  }

  readThrough(_path: PathSpec, fetch: () => Promise<Uint8Array>): Promise<Uint8Array> {
    return fetch()
  }

  cachedSize(): Promise<number | null> {
    return Promise.resolve(null)
  }

  listingTrusted(): boolean {
    return false
  }

  probedStat(): FileStat | null {
    return null
  }
}

/** Run `fn` with a fresh {@link SettleRecorder} active, and return it. */
export async function settling(
  fn: (recorder: SettleRecorder) => Promise<unknown>,
): Promise<SettleRecorder> {
  const recorder = new SettleRecorder()
  await runWithCacheManager(recorder, async () => {
    await fn(recorder)
  })
  return recorder
}
