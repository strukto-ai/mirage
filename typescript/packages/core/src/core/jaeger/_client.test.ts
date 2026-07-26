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

import { describe, expect, it } from 'vitest'
import { JaegerApiError, fetchTraces, isTraceId, type JaegerTransport } from './_client.ts'

class RecordingTransport implements JaegerTransport {
  readonly calls: { path: string; query?: Record<string, string | number | undefined> }[] = []

  constructor(
    private readonly body: unknown,
    private readonly error?: JaegerApiError,
  ) {}

  request(path: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    this.calls.push({ path, ...(query !== undefined ? { query } : {}) })
    if (this.error !== undefined) return Promise.reject(this.error)
    return Promise.resolve(this.body)
  }
}

describe('jaeger isTraceId', () => {
  it.each([
    ['a'.repeat(32), true],
    ['a'.repeat(16), true],
    ['A'.repeat(32), true],
    ['zzz', false],
    ['a'.repeat(31), false],
    ['a'.repeat(33), false],
    ['', false],
  ])('%s -> %s', (value, valid) => {
    expect(isTraceId(value)).toBe(valid)
  })
})

describe('jaeger fetchTraces window', () => {
  it('always sends an explicit microsecond window', async () => {
    // Jaeger ignores `lookback`, so without start/end the search silently
    // returns nothing.
    const transport = new RecordingTransport({ data: [] })
    await fetchTraces(transport, 'checkout', { limit: 7 })
    const call = transport.calls[0]
    expect(call?.path).toBe('/api/traces')
    expect(call?.query?.service).toBe('checkout')
    expect(call?.query?.limit).toBe(7)
    expect(call?.query?.start).toBe(0)
    expect(Number(call?.query?.end)).toBeGreaterThan(0)
  })

  it('converts an ISO window to microseconds', async () => {
    const transport = new RecordingTransport({ data: [] })
    await fetchTraces(transport, 'checkout', {
      fromTimestamp: '2026-01-01T00:00:00Z',
      toTimestamp: '2026-01-02T00:00:00Z',
    })
    expect(transport.calls[0]?.query?.start).toBe(1767225600000000)
    expect(transport.calls[0]?.query?.end).toBe(1767312000000000)
  })

  it('propagates api errors', async () => {
    const transport = new RecordingTransport(null, new JaegerApiError('bad request', 400))
    await expect(fetchTraces(transport, 'checkout')).rejects.toBeInstanceOf(JaegerApiError)
  })
})
