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
import { buildRuntime } from '@struktoai/mirage-core'
import { LocalRuntime } from './local.ts'

const DEC = new TextDecoder()

describe('LocalRuntime', () => {
  it('runs code on the host python with argv, stdin and env', async () => {
    const rt = new LocalRuntime()
    const result = await rt.run({
      code: 'import os, sys; print(sys.argv[1:], sys.stdin.read(), os.environ["K"])',
      args: ['alpha', 'beta'],
      stdin: new TextEncoder().encode('piped'),
      env: { K: 'V' },
      flags: {},
    })
    expect(result.exitCode).toBe(0)
    expect(DEC.decode(result.stdout)).toBe("['alpha', 'beta'] piped V\n")
  })

  it('reports the interpreter exit code and stderr', async () => {
    const rt = new LocalRuntime()
    const result = await rt.run({
      code: 'import sys; sys.exit(3)',
      args: [],
      stdin: null,
      env: {},
      flags: {},
    })
    expect(result.exitCode).toBe(3)
  })

  it('a missing interpreter fails with the config hint', async () => {
    const rt = new LocalRuntime({ config: { home: '/nope/python-does-not-exist' } })
    await expect(
      rt.run({ code: 'print(1)', args: [], stdin: null, env: {}, flags: {} }),
    ).rejects.toThrow(/local python interpreter not found/)
  })

  it('an aborted signal kills the interpreter (limit timeout path)', async () => {
    const rt = new LocalRuntime()
    const ctl = new AbortController()
    const started = Date.now()
    const pending = rt.run({
      code: 'import time; time.sleep(60)',
      args: [],
      stdin: null,
      env: {},
      flags: {},
      signal: ctl.signal,
    })
    setTimeout(() => {
      ctl.abort()
    }, 100)
    const result = await pending
    expect(Date.now() - started).toBeLessThan(5000)
    expect(result.exitCode).not.toBe(0)
  })

  it('stdin larger than the pipe buffer to an early-exiting program is not an error', async () => {
    const rt = new LocalRuntime()
    const result = await rt.run({
      code: 'pass',
      args: [],
      stdin: new Uint8Array(4 * 1024 * 1024),
      env: {},
      flags: {},
    })
    expect(result.exitCode).toBe(0)
  })

  it('close() kills any child still running', async () => {
    const rt = new LocalRuntime()
    const pending = rt.run({
      code: 'import time; time.sleep(60)',
      args: [],
      stdin: null,
      env: {},
      flags: {},
    })
    await new Promise((r) => setTimeout(r, 100))
    await rt.close()
    const result = await pending
    expect(result.exitCode).not.toBe(0)
  })

  it('registers under the local name', () => {
    expect(buildRuntime('local')).toBeInstanceOf(LocalRuntime)
  })
})
