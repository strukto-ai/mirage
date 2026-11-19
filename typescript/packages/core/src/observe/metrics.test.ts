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

import { beforeAll, describe, expect, it } from 'vitest'
import { metrics } from '@opentelemetry/api'
import {
  AggregationTemporality,
  MeterProvider,
  MetricReader,
  type DataPoint,
  type Histogram,
} from '@opentelemetry/sdk-metrics'
import { MountMode } from '../types.ts'
import { RAMVFS } from '../vfs/ram/ram.ts'
import { Workspace } from '../workspace/workspace/workspace.ts'

class Reader extends MetricReader {
  constructor() {
    super({ aggregationTemporalitySelector: () => AggregationTemporality.CUMULATIVE })
  }

  protected onShutdown(): Promise<void> {
    return Promise.resolve()
  }

  protected onForceFlush(): Promise<void> {
    return Promise.resolve()
  }
}

type Key = string

/** One metric's points, keyed by their sorted attributes: a histogram's sum and count, a counter's value. */
async function points(
  reader: Reader,
  name: string,
): Promise<Map<Key, [number, number | undefined]>> {
  const out = new Map<Key, [number, number | undefined]>()
  const { resourceMetrics } = await reader.collect()
  for (const scope of resourceMetrics.scopeMetrics) {
    for (const metric of scope.metrics) {
      if (metric.descriptor.name !== name) continue
      for (const point of metric.dataPoints as DataPoint<number | Histogram>[]) {
        const key = JSON.stringify(Object.entries(point.attributes).sort())
        const value = point.value
        out.set(key, typeof value === 'number' ? [value, undefined] : [value.sum ?? 0, value.count])
      }
    }
  }
  return out
}

function key(attributes: Record<string, string | number>): Key {
  return JSON.stringify(Object.entries(attributes).sort())
}

let reader: Reader

beforeAll(() => {
  reader = new Reader()
  metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] }))
})

describe('observer metrics', () => {
  // Each typed line counts once in mirage.shell.duration under its exit
  // code, and each call it makes to a mount in mirage.vfs.duration and,
  // when it moved bytes, mirage.vfs.io, under the call and the backend.
  it('counts lines and their mount calls by low-cardinality labels', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    try {
      await ws.shell('echo hi > /data/a.txt')
      await ws.shell('cat /data/a.txt')
      await ws.shell('cat /data/missing.txt')
    } finally {
      await ws.close()
    }
    const lines = await points(reader, 'mirage.shell.duration')
    expect(new Map([...lines].map(([k, [, count]]) => [k, count]))).toEqual(
      new Map([
        [key({ 'mirage.exit_code': 0 }), 2],
        [key({ 'mirage.exit_code': 1 }), 1],
      ]),
    )
    const io = await points(reader, 'mirage.vfs.io')
    expect(io.get(key({ 'mirage.vfs.op': 'write', 'mirage.vfs.source': 'ram' }))?.[0]).toBe(3)
    expect(io.get(key({ 'mirage.vfs.op': 'read', 'mirage.vfs.source': 'ram' }))?.[0]).toBe(3)
    const calls = await points(reader, 'mirage.vfs.duration')
    expect(calls.has(key({ 'mirage.vfs.op': 'read', 'mirage.vfs.source': 'ram' }))).toBe(true)
    for (const k of calls.keys()) {
      expect((JSON.parse(k) as [string, unknown][]).map(([name]) => name)).toEqual([
        'mirage.vfs.op',
        'mirage.vfs.source',
      ])
    }
  })

  // A call made to a mount outside any line counts too.
  it('counts a call made outside a line', async () => {
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
    const read = key({ 'mirage.vfs.op': 'read', 'mirage.vfs.source': 'ram' })
    let before: number
    try {
      await ws.shell('echo hello > /data/b.txt')
      before = (await points(reader, 'mirage.vfs.io')).get(read)?.[0] ?? 0
      await ws.vfs.read('/data/b.txt')
      await new Promise((resolve) => setTimeout(resolve, 0))
    } finally {
      await ws.close()
    }
    expect(((await points(reader, 'mirage.vfs.io')).get(read)?.[0] ?? 0) - before).toBe(6)
  })
})
