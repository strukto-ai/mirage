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
import { materialize } from '../../../io/types.ts'
import type { CommandOpts } from '../../config.ts'
import { resolveSource } from '../utils/stream.ts'
import { headGeneric } from './head.ts'

describe('headGeneric line counts', () => {
  // Every pull is ready and no line ends, so only the scan's own checkpoint
  // lets the abort timer run.
  it.each([
    ['1', 'x'],
    ['1', ''],
    ['-1', 'x'],
    ['-1', ''],
  ])('-n %s lets an abort into a ready input of %j pulls', async (lines, piece) => {
    const bytes = new TextEncoder().encode(piece)
    async function* ready(): AsyncIterable<Uint8Array> {
      for (let i = 0; i < 2_000_000; i++) {
        await Promise.resolve()
        yield bytes
      }
    }
    const abort = new AbortController()
    const opts = { stdin: ready(), flags: { lines }, cwd: '/', vfs: {}, signal: abort.signal }
    const result = await headGeneric(
      [],
      [],
      opts as CommandOpts,
      () => Promise.reject(new Error('stdin only')),
      () => resolveSource(null),
    )
    const [stdout] = result ?? [null]
    const timer = setTimeout(() => {
      abort.abort()
    }, 5)
    try {
      await expect(materialize(stdout)).rejects.toMatchObject({ name: 'AbortError' })
    } finally {
      clearTimeout(timer)
    }
  })

  // A lazy output's timeout leaves the signal alone, so a count inside one
  // whole read checks the invocation's deadline itself.
  it('-n -K stops at the command deadline', async () => {
    const opts = {
      stdin: new TextEncoder().encode('\n'.repeat(20_000_000)),
      flags: { lines: '-20000000' },
      cwd: '/',
      vfs: {},
      timeoutSeconds: 0.02,
      command: 'head',
    }
    const result = await headGeneric(
      [],
      [],
      opts as CommandOpts,
      () => Promise.reject(new Error('stdin only')),
      () => resolveSource(null),
    )
    const [stdout] = result ?? [null]
    const start = performance.now()
    await expect(materialize(stdout)).rejects.toMatchObject({ name: 'CommandTimeoutError' })
    expect(performance.now() - start).toBeLessThan(1000)
  })

  // A backend head calls the scan without the factory's guard, so a pull that
  // stalls must still lose to the abort, and its late line must not print.
  it.each([{ lines: '1' }, { bytes: '1' }])(
    '%o ends a stalled pull at the abort',
    async (flags) => {
      async function* stalled(): AsyncIterable<Uint8Array> {
        await new Promise((resolve) => setTimeout(resolve, 2000))
        yield new TextEncoder().encode('late\n')
      }
      const abort = new AbortController()
      const opts = { stdin: stalled(), flags, cwd: '/', vfs: {}, signal: abort.signal }
      const result = await headGeneric(
        [],
        [],
        opts as CommandOpts,
        () => Promise.reject(new Error('stdin only')),
        () => resolveSource(null),
      )
      const [stdout] = result ?? [null]
      const start = performance.now()
      const timer = setTimeout(() => {
        abort.abort()
      }, 5)
      try {
        await expect(materialize(stdout)).rejects.toMatchObject({ name: 'AbortError' })
      } finally {
        clearTimeout(timer)
      }
      expect(performance.now() - start).toBeLessThan(1000)
    },
  )
})
