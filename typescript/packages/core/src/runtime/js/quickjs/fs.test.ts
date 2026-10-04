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

import { WorkspaceBinding } from '../../binding.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { MountMode } from '../../../types.ts'
import { getTestParser } from '../../../workspace/fixtures/workspace_fixture.ts'
import { Workspace } from '../../../workspace/workspace/workspace.ts'
import { describe, expect, it } from 'vitest'
import { QuickJsRuntime } from './runtime.ts'
import { PrefixResolver } from '../../resolver.ts'
import type { BridgeDispatchFn, RunArgs } from '../../types.ts'

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
    // A missing file has no listing either, as a real mount answers.
    if (op === 'readdir') {
      return Promise.reject(Object.assign(new Error(`no dir: ${path}`), { code: 'ENOENT' }))
    }
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
    rt.bind(new WorkspaceBinding(bridge.dispatch, new PrefixResolver(() => ['/data/'])))
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
    rt.bind(new WorkspaceBinding(bridge.dispatch, new PrefixResolver(() => ['/data/'])))
    const result = await rt.run(runArgs(OPEN_APPEND_JS))
    await rt.close()
    expect(result.exitCode).toBe(0)
    expect(DEC.decode(result.stdout)).toBe('opened\n')
    expect(bridge.ops).toContain('create')
  }, 120_000)
})

describe('quickjs gives the event loop a turn', () => {
  it('lets a timer run while a guest loops over files on a RAM mount', async () => {
    // A RAM mount answers every call in microtasks alone, so without a
    // turn a guest looping over files held the loop until it ended, and
    // another session's I/O and timers waited the whole run.
    const parser = await getTestParser()
    const ws = new Workspace(
      { '/data': new RAMVFS() },
      { mode: MountMode.EXEC, shellParserFactory: () => Promise.resolve(parser) },
    )
    try {
      await ws.shell('echo hi > /data/f.txt')
      let last = performance.now()
      let longest = 0
      const timer = setInterval(() => {
        const now = performance.now()
        longest = Math.max(longest, now - last)
        last = now
      }, 0)
      const result = await ws.shell(
        "node -e \"const end = Date.now() + 400; while (Date.now() < end) std.open('/data/f.txt', 'r').close()\"",
      )
      clearInterval(timer)
      longest = Math.max(longest, performance.now() - last)
      expect(result.exitCode).toBe(0)
      expect(longest).toBeLessThan(200)
    } finally {
      await ws.close()
    }
  }, 120_000)
})
