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
import { LineId } from '../types.ts'
import { LineHandle } from './handle.ts'

describe('LineHandle', () => {
  it('waits, runs and ends once', async () => {
    let now = 100
    const started: boolean[] = []
    const line = new LineHandle(
      new LineId('l1'),
      's',
      'echo hi',
      () => {
        started.push(true)
        return Promise.resolve()
      },
      () => now,
    )
    expect([line.record.state, line.record.startedAt]).toEqual(['waiting', 100])
    await line.start()
    await line.start()
    expect(started).toEqual([true])
    expect(line.record.state).toBe('running')
    now = 105
    line.end(0)
    line.end(1, 'late')
    const record = line.record
    expect([record.state, record.endedAt, record.exit]).toEqual(['exited', 105, 0])
    expect([record.signal, record.error]).toEqual([null, null])
  })

  it('ends a stopped line as stopped by its signal', async () => {
    const line = new LineHandle(new LineId('l1'), 's', 'sleep 9')
    await line.start()
    line.stop(2)
    expect(line.record.state).toBe('stopping')
    line.end(130)
    expect([line.record.signal, line.record.exit]).toEqual([2, 130])
    line.stop(15)
    expect(line.record.signal).toBe(2)
  })

  it('keeps the line waiting when its admission throws', async () => {
    const line = new LineHandle(new LineId('l1'), 's', 'true', () =>
      Promise.reject(new Error('cancelled before admission')),
    )
    await expect(line.start()).rejects.toThrow('cancelled before admission')
    expect(line.record.state).toBe('waiting')
  })
})
