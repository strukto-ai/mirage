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

import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { FileStat, FileType, MountMode } from '../../../types.ts'
import { Workspace } from '../../../workspace/workspace/workspace.ts'
import { describe, expect, it } from 'vitest'
import { QuickJsRuntime } from './runtime.ts'
import { PrefixResolver } from '../../resolver.ts'
import type { BridgeDispatchFn, RunResult } from '../../types.ts'
import { bindOver, runContext } from '../../../../tests/runtime/fixtures/bridge.ts'

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

async function run(rt: QuickJsRuntime, code: string): Promise<RunResult> {
  return rt.interpret(await rt.engine(), { code, args: [], stdin: null }, runContext(rt))
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
    bindOver(rt, bridge.dispatch, new PrefixResolver(() => ['/data/']))
    const result = await run(rt, OPEN_APPEND_JS)
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
    bindOver(rt, bridge.dispatch, new PrefixResolver(() => ['/data/']))
    const result = await run(rt, OPEN_APPEND_JS)
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
    const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.EXEC })
    try {
      await ws.shell('echo hi > /data/f.txt')
      let last = performance.now()
      let longest = 0
      const timer = setInterval(() => {
        const now = performance.now()
        longest = Math.max(longest, now - last)
        last = now
      }, 0)
      try {
        const result = await ws.shell(
          "node -e \"const end = Date.now() + 400; while (Date.now() < end) std.open('/data/f.txt', 'r').close()\"",
        )
        longest = Math.max(longest, performance.now() - last)
        expect(result.exitCode).toBe(0)
        expect(longest).toBeLessThan(200)
      } finally {
        clearInterval(timer)
      }
    } finally {
      await ws.close()
    }
  }, 120_000)
})

describe('quickjs reads after a failed fetch', () => {
  it('fails the read, and reads again once the stream is cleared', async () => {
    // A fetch that fails sets the stream's error flag, as fread does,
    // and clearerr lets the next read ask the mount again.
    class Flaky extends RAMVFS {
      failures = 0
      override read(...args: Parameters<RAMVFS['read']>): ReturnType<RAMVFS['read']> {
        if (this.failures > 0) {
          this.failures -= 1
          return Promise.reject(new Error('upstream 502 Bad Gateway'))
        }
        return super.read(...args)
      }
    }
    const flaky = new Flaky()
    const ws = new Workspace({ '/data': flaky }, { mode: MountMode.EXEC })
    try {
      await ws.shell('echo content > /data/f.txt')
      flaky.failures = 1
      const program = [
        "const f = std.open('/data/f.txt', 'r')",
        'const first = f.readAsString()',
        'const failed = f.error()',
        'f.clearerr()',
        'console.log(JSON.stringify(first), failed, JSON.stringify(f.readAsString()))',
        'f.close()',
      ].join('; ')
      const result = await ws.shell(`node -e "${program}"`)
      expect(DEC.decode(result.stdout)).toBe('"" true "content\\n"\n')
      expect(result.exitCode).toBe(0)
    } finally {
      await ws.close()
    }
  }, 120_000)
})

describe('QuickJS retained reads', () => {
  // What is judged is what the read takes: a line, its newline too.
  it.each([
    ['text', 'f.readAsString(2)', "'cd'", 'cd'],
    [
      'bytes',
      "(()=>{const b=new ArrayBuffer(2); const n=f.read(b,0,2); return Array.from(new Uint8Array(b)).slice(0,n).join(',')})()",
      "'99,100'",
      'cd',
    ],
    ['line', 'f.getline()', "'cd'", 'cd\n'],
  ])(
    'checks a retained %s read and leaves a refused cursor unchanged',
    async (_name, read, expected, judged) => {
      let fetched = 0
      const checked: string[] = []
      const dispatch: BridgeDispatchFn = (op, _path, _bytes, _dst, attrs) => {
        if (op === 'stat')
          return Promise.resolve(new FileStat({ name: 'f.txt', type: FileType.FILE, size: 5 }))
        if (op === 'read') {
          if (attrs?.retained instanceof Uint8Array) {
            checked.push(DEC.decode(attrs.retained))
            if (checked.length === 1)
              return Promise.reject(Object.assign(new Error('sealed'), { code: 'EACCES' }))
            return Promise.resolve(attrs.retained)
          }
          fetched++
          return Promise.resolve(new TextEncoder().encode('abcd\n'))
        }
        return Promise.resolve(undefined)
      }
      const rt = new QuickJsRuntime()
      bindOver(rt, dispatch, new PrefixResolver(() => ['/data/']))
      try {
        const result = await run(
          rt,
          `
const f = std.open('/data/f.txt', 'r');
console.log(f.readAsString(2));
${read};
console.log(f.error(), f.tell());
f.clearerr();
console.log(${read} === ${expected});
f.close();
`,
        )
        expect(result.exitCode).toBe(0)
        expect(DEC.decode(result.stdout)).toBe('ab\ntrue 2\ntrue\n')
        expect(fetched).toBe(1)
        expect(checked).toEqual([judged, judged])
      } finally {
        await rt.close()
      }
    },
    120_000,
  )
})

it('stops file calls and output immediately after an awaited read revokes the run', async () => {
  const controller = new AbortController()
  const calls: string[] = []
  const dispatch: BridgeDispatchFn = (op) => {
    calls.push(op)
    if (op === 'stat')
      return Promise.resolve(new FileStat({ name: 'f', type: FileType.FILE, size: 1 }))
    if (op === 'read') {
      controller.abort(new Error('revoked'))
      return Promise.resolve(new TextEncoder().encode('x'))
    }
    return Promise.resolve(undefined)
  }
  const rt = new QuickJsRuntime()
  bindOver(rt, dispatch, new PrefixResolver(() => ['/data/']))
  try {
    const result = await rt.interpret(
      await rt.engine(),
      {
        code: `
console.log('before');
const f = std.open('/data/f', 'r');
try { f.readAsString() } catch (e) {}
try { const w = std.open('/data/continued', 'w'); w.puts('after'); w.close() } catch (e) {}
try { console.log('after') } catch (e) {}
`,
        args: [],
        stdin: null,
      },
      runContext(rt, { signal: controller.signal }),
    )
    expect(DEC.decode(result.stdout)).toBe('before\n')
    expect(calls.at(-1)).toBe('read')
    expect(calls).not.toContain('create')
    expect(calls).not.toContain('write')
  } finally {
    await rt.close()
  }
}, 120_000)

it('does not create a file when its open stat revokes the run', async () => {
  const controller = new AbortController()
  const calls: string[] = []
  const dispatch: BridgeDispatchFn = (op) => {
    calls.push(op)
    if (op === 'stat') {
      controller.abort(new Error('revoked'))
      return Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    }
    return Promise.resolve(undefined)
  }
  const rt = new QuickJsRuntime()
  bindOver(rt, dispatch, new PrefixResolver(() => ['/data/']))
  try {
    const result = await rt.interpret(
      await rt.engine(),
      {
        code: "try { const f = std.open('/data/new', 'w'); f.puts('forbidden'); f.close() } catch (e) {}",
        args: [],
        stdin: null,
      },
      runContext(rt, { signal: controller.signal }),
    )
    expect(DEC.decode(result.stdout)).toBe('')
    expect(calls).toEqual(['stat'])
  } finally {
    await rt.close()
  }
}, 120_000)

it('lands what a revoked run wrote before the revoke', async () => {
  const controller = new AbortController()
  const calls: string[] = []
  let made = false
  const dispatch: BridgeDispatchFn = (op, path) => {
    calls.push(`${op} ${path}`)
    if (path === '/data/out') {
      if (op === 'create') made = true
      if ((op === 'stat' || op === 'readdir') && !made)
        return Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }))
      if (op === 'stat')
        return Promise.resolve(new FileStat({ name: 'out', type: FileType.FILE, size: 0 }))
      return Promise.resolve(undefined)
    }
    if (op === 'stat')
      return Promise.resolve(new FileStat({ name: 'f', type: FileType.FILE, size: 1 }))
    if (op === 'read') {
      controller.abort(new Error('revoked'))
      return Promise.resolve(new TextEncoder().encode('x'))
    }
    return Promise.resolve(undefined)
  }
  const rt = new QuickJsRuntime()
  bindOver(rt, dispatch, new PrefixResolver(() => ['/data/']))
  try {
    await rt.interpret(
      await rt.engine(),
      {
        code: `
const w = std.open('/data/out', 'w');
w.puts('kept');
const f = std.open('/data/f', 'r');
try { f.readAsString() } catch (e) {}
try { std.open('/data/later', 'w') } catch (e) {}
`,
        args: [],
        stdin: null,
      },
      runContext(rt, { signal: controller.signal }),
    )
    expect(calls).toContain('pwrite /data/out')
    expect(calls.filter((call) => call.endsWith('/data/later'))).toEqual([])
  } finally {
    await rt.close()
  }
}, 120_000)
