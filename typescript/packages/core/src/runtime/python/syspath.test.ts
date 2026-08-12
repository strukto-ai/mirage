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
import { PrefixResolver } from '../resolver.ts'
import { PyodideRuntime } from './pyodide.ts'
import type { BridgeDispatchFn } from '../types.ts'

const EMPTY_MOUNT: BridgeDispatchFn = (op) => Promise.resolve(op === 'readdir' ? [] : new Uint8Array())

function decode(bytes: Uint8Array | null | undefined): string {
  return bytes ? new TextDecoder().decode(bytes) : ''
}

describe('PyodideRuntime sysPath', () => {
  it('reports a glob that matched nothing on the run stderr', async () => {
    const rt = new PyodideRuntime({ config: { sysPath: ['/ram/*.whl'] } })
    rt.attach(EMPTY_MOUNT, new PrefixResolver(() => ['/ram/']))
    const result = await rt.run({ code: 'print(1)', args: [], env: {}, stdin: new Uint8Array() })
    expect(decode(result.stderr)).toContain('/ram/*.whl')
    expect(decode(result.stderr)).toContain('matched nothing')
    // A misconfigured path is a warning, not a failure: the program ran.
    expect(decode(result.stdout)).toContain('1')
    expect(result.exitCode).toBe(0)
    await rt.close()
  }, 60_000)

  it('reports each missing glob once, not on every run', async () => {
    const rt = new PyodideRuntime({ config: { sysPath: ['/ram/*.whl'] } })
    rt.attach(EMPTY_MOUNT, new PrefixResolver(() => ['/ram/']))
    const args = { code: 'print(1)', args: [], env: {}, stdin: new Uint8Array() }
    await rt.run(args)
    const second = await rt.run(args)
    expect(decode(second.stderr)).not.toContain('matched nothing')
    await rt.close()
  }, 60_000)

  it('says nothing about a literal path that does not exist', async () => {
    // Only a glob can silently expand to nothing; a literal entry is on
    // sys.path exactly as configured, which is what CPython does too.
    const rt = new PyodideRuntime({ config: { sysPath: ['/ram/vendor'] } })
    rt.attach(EMPTY_MOUNT, new PrefixResolver(() => ['/ram/']))
    const result = await rt.run({
      code: `import sys; print('/ram/vendor' in sys.path)`,
      args: [],
      env: {},
      stdin: new Uint8Array(),
    })
    expect(decode(result.stderr)).not.toContain('matched nothing')
    expect(decode(result.stdout)).toContain('True')
    await rt.close()
  }, 60_000)
})
