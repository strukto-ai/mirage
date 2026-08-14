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
import { QuickJsRuntime } from './quickjs.ts'
import { PrefixResolver } from '../resolver.ts'
import type { BridgeDispatchFn, RunArgs } from '../types.ts'

const DEC = new TextDecoder()

interface StatProbeBridge {
  dispatch: BridgeDispatchFn
  ops: string[]
}

// A bridge whose stat answers with one canned rejection while the file's
// content is real and readable, so the open ladder's reading of that
// failure is the only thing under test. Real dispatch errors arrive
// code-stamped (the workspace chokepoints classify them), so the canned
// ones are too.
function makeStatProbeBridge(statCode: string, content: string): StatProbeBridge {
  const ops: string[] = []
  const dispatch: BridgeDispatchFn = (op, path) => {
    ops.push(op)
    if (op === 'stat') {
      return Promise.reject(Object.assign(new Error(`stat refused: ${path}`), { code: statCode }))
    }
    if (op === 'read') return Promise.resolve(new TextEncoder().encode(content))
    return Promise.resolve(undefined)
  }
  return { dispatch, ops }
}

function runArgs(code: string): RunArgs {
  return { code, args: [], env: {}, stdin: null }
}

const OPEN_APPEND_JS = `const f = std.open('/data/f.txt', 'a');
console.log(f === null ? 'refused' : 'opened');
if (f !== null) f.close();`

// The open ladder treats a stat miss as "no file yet", which is what
// lets create-capable modes establish one. Only a confirmed absence may
// read that way: a transient backend failure or a policy denial on an
// existing file must refuse the open, or 'a'/'w' would create over
// content this open never saw.
describe('quickjs std.open reads stat failures', () => {
  it('a non-absence stat failure refuses the open and mutates nothing', async () => {
    const bridge = makeStatProbeBridge('EIO', 'precious')
    const rt = new QuickJsRuntime()
    rt.attach(bridge.dispatch, new PrefixResolver(() => ['/data/']))
    const result = await rt.run(runArgs(OPEN_APPEND_JS))
    await rt.close()
    expect(result.exitCode).toBe(0)
    expect(DEC.decode(result.stdout)).toBe('refused\n')
    expect(bridge.ops).not.toContain('create')
    expect(bridge.ops).not.toContain('truncate')
    expect(bridge.ops).not.toContain('write')
    expect(bridge.ops).not.toContain('append')
  }, 120_000)

  it('a confirmed absence still lets a create-capable mode establish', async () => {
    const bridge = makeStatProbeBridge('ENOENT', '')
    const rt = new QuickJsRuntime()
    rt.attach(bridge.dispatch, new PrefixResolver(() => ['/data/']))
    const result = await rt.run(runArgs(OPEN_APPEND_JS))
    await rt.close()
    expect(result.exitCode).toBe(0)
    expect(DEC.decode(result.stdout)).toBe('opened\n')
    expect(bridge.ops).toContain('create')
  }, 120_000)
})
