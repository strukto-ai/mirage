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

import { PerformanceObserver, performance } from 'node:perf_hooks'

/**
 * The file serve.ts writes a LoopLag summary to as the server stops, for
 * run.py to report; the server itself neither keeps nor serves it.
 */
export const LOOP_LAG_ENV = 'ACCESS_LOOP_LAG'
const INTERVAL_MS = 20
const STALL_MS = 50

export interface LoopLagSummary {
  samples: number
  p50_ms: number
  p99_ms: number
  max_ms: number
  stalls: number
  gc_ms: number
}

/** The nearest-rank percentile of sorted samples, 0 when there are none. */
export function percentile(ordered: readonly number[], fraction: number): number {
  const rank = Math.ceil(ordered.length * fraction)
  return ordered[Math.min(ordered.length, Math.max(1, rank)) - 1] ?? 0
}

function tenths(ms: number): number {
  return Math.round(ms * 10) / 10
}

/**
 * How late the event loop runs a timer, and how long collections took.
 *
 * A timer due every `INTERVAL_MS` records how far past its due time it
 * ran: time the loop spent on anything else, such as a callback that
 * never awaits or a collection.
 */
export class LoopLag {
  private readonly lags: number[] = []
  private gcMs = 0
  private timer: NodeJS.Timeout | null = null
  private observer: PerformanceObserver | null = null
  private due = 0

  /** Sample the event loop and time every collection. */
  start(): void {
    this.observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) this.gcMs += entry.duration
    })
    this.observer.observe({ entryTypes: ['gc'] })
    this.arm()
  }

  /** Stop sampling and summarize the run. */
  stop(): LoopLagSummary {
    if (this.timer !== null) clearTimeout(this.timer)
    if (this.observer !== null) {
      for (const entry of this.observer.takeRecords()) this.gcMs += entry.duration
      this.observer.disconnect()
    }
    const lags = [...this.lags].sort((a, b) => a - b)
    return {
      samples: lags.length,
      p50_ms: tenths(percentile(lags, 0.5)),
      p99_ms: tenths(percentile(lags, 0.99)),
      max_ms: tenths(lags.at(-1) ?? 0),
      stalls: lags.filter((lag) => lag >= STALL_MS).length,
      gc_ms: tenths(this.gcMs),
    }
  }

  private arm(): void {
    this.due = performance.now() + INTERVAL_MS
    this.timer = setTimeout(() => {
      this.lags.push(Math.max(0, performance.now() - this.due))
      this.arm()
    }, INTERVAL_MS)
    this.timer.unref()
  }
}
