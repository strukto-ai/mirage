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
import { PyodideRuntime } from './pyodide.ts'

// The runtime declares reach='vfs', meaning the workspace bridge is the
// guest's only door to the outside. Pyodide's default exposes the host
// globalThis as the `js` module, which under Node hands the guest
// js.process (host env) and js.fetch (network) — doors around the
// bridge. loader.ts seals that with a null-prototype jsglobals; this
// pins the seal so a future edit that drops it fails loudly.
describe('PyodideRuntime js-module door', () => {
  it('the guest cannot reach host process or network through js', async () => {
    const rt = new PyodideRuntime()
    const probe = `
import js
flags = []
flags.append("process=" + str(hasattr(js, "process")))
flags.append("fetch=" + str(hasattr(js, "fetch")))
flags.append("require=" + str(hasattr(js, "require")))
print(",".join(flags))
`
    const result = await rt.run({
      code: probe,
      args: [],
      env: {},
      stdin: new Uint8Array(),
    })
    const decode = (b: Uint8Array | string | null): string =>
      typeof b === 'string' ? b : new TextDecoder().decode(b ?? new Uint8Array())
    expect(decode(result.stderr)).toBe('')
    expect(result.exitCode).toBe(0)
    expect(decode(result.stdout).trim()).toBe('process=False,fetch=False,require=False')
    await rt.close()
  }, 60_000)
})
