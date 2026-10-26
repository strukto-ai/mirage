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
import { QuickJsRuntime } from './runtime.ts'
import { Workspace } from '../../../workspace/workspace/workspace.ts'
import { RAMVFS } from '../../../vfs/ram/ram.ts'
import { MountMode, PathSpec } from '../../../types.ts'
import type { Context } from '../../../commands/config.ts'
import { context } from '../../../../tests/workspace/fixtures/context.ts'

function execute(rt: QuickJsRuntime, code: string, extra: Partial<Context> = {}) {
  return rt.execute([], [], context({ flags: { c: code }, ...extra }))
}

describe('QuickJS cwd', () => {
  it("a bound run takes the caller's cwd, not the session's", async () => {
    const rt = new QuickJsRuntime()
    const ws = new Workspace(
      { '/data': new RAMVFS() },
      {
        mode: MountMode.EXEC,
        runtimes: [rt, 'workspace'],
      },
    )
    const code = 'console.log(os.getcwd()[0])'
    const dec = new TextDecoder()
    try {
      expect(
        (await ws.shell('mkdir /data/sub; echo child > /data/sub/item; cd /data')).exitCode,
      ).toBe(0)
      expect(dec.decode((await execute(rt, code)).stdout)).toBe('/\n')
      expect(
        dec.decode((await execute(rt, code, { cwd: PathSpec.fromStrPath('/data/sub') })).stdout),
      ).toBe('/data/sub\n')
      const bad = await execute(rt, "console.log('must not run')", {
        cwd: PathSpec.fromStrPath('/missing'),
      })
      expect(bad.exitCode).toBe(1)
      expect(dec.decode(bad.stdout)).toBe('')
      expect(dec.decode(bad.stderr ?? new Uint8Array())).toContain('cannot change directory')
      expect(dec.decode((await execute(rt, code)).stdout)).toBe('/\n')
    } finally {
      await ws.close()
    }
  })
})

// The guest runs on the event loop, so a loop that never yields holds back
// the timer `timeout` keeps; the VM's interrupt hook meets the deadline.
it.each([
  ['timeout 1 node -e "for (;;) {}"', 124],
  ['timeout -s CONT -k 1 1 node -e "for (;;) {}"', 137],
  ['timeout 1 node -e "Promise.resolve().then(() => { for (;;) {} })"', 124],
  ['timeout 1 node -e "(async () => { await 0; for (;;) {} })()"', 124],
])(
  'a deadline stops a guest that never yields: %s',
  async (line, code) => {
    const ws = new Workspace(
      { '/data': new RAMVFS() },
      {
        mode: MountMode.EXEC,
        runtimes: [new QuickJsRuntime(), 'workspace'],
      },
    )
    try {
      const io = await ws.shell(line)
      expect(io.exitCode).toBe(code)
      expect(io.stderrText).toBe('')
    } finally {
      await ws.close()
    }
  },
  20_000,
)

function slow(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 600))
}

class SlowRAMVFS extends RAMVFS {
  override async pwrite(...args: Parameters<RAMVFS['pwrite']>): ReturnType<RAMVFS['pwrite']> {
    await slow()
    return super.pwrite(...args)
  }

  override async write(...args: Parameters<RAMVFS['write']>): ReturnType<RAMVFS['write']> {
    await slow()
    return super.write(...args)
  }
}

it('a deadline joins the landing of what a stopped guest wrote', async () => {
  // The run's end closes the file it left open, which takes longer than a
  // plain abort's grace: the stop names a signal, so the line waits for it,
  // as a kill's does. What qjs's own stdio still held is lost with the
  // guest, as a killed process's is, so the file is there and empty; the
  // stderr the guest wrote before the stop is kept.
  const ws = new Workspace(
    { '/data': new SlowRAMVFS() },
    {
      mode: MountMode.EXEC,
      runtimes: [new QuickJsRuntime(), 'workspace'],
    },
  )
  try {
    const io = await ws.shell(
      `timeout 1 node -e "std.err.puts('warn\\n'); const f = std.open('/data/o', 'w'); f.puts('kept'); for (;;) {}"; cat /data/o`,
    )
    expect([io.stdoutText, io.stderrText]).toEqual(['', 'warn\n'])
  } finally {
    await ws.close()
  }
}, 20_000)

function full(): Promise<void> {
  return Promise.reject(Object.assign(new Error('no space'), { code: 'ENOSPC' }))
}

// A FILE's writes land at its close, as the core keeps an open file's
// writes; the close is what reports a landing that failed (as on the
// Python host's qjs).
it('reports a failed landing at the close of the FILE that wrote it', async () => {
  class FullVFS extends RAMVFS {
    override append = full
    override pwrite = full
    override write = full
  }
  const rt = new QuickJsRuntime()
  const ws = new Workspace(
    { '/data': new FullVFS() },
    { mode: MountMode.EXEC, runtimes: [rt, 'workspace'] },
  )
  try {
    const result = await execute(
      rt,
      "const f = std.open('/data/x', 'w'); f.puts('x'); print(String(f.flush()), f.error()); print(f.close())",
    )
    expect(new TextDecoder().decode(result.stdout)).toBe('undefined false\n-29\n')
  } finally {
    await ws.close()
  }
})

// The descriptor calls and a FILE's byte calls answer as the real engine on
// WASI does (pinned through the python runtime's qjs): numbers from 4, a
// count or -errno, and os.seek the offset, a bigint for a bigint.
it('answers the descriptor and byte calls as qjs on WASI does', async () => {
  const rt = new QuickJsRuntime()
  const ws = new Workspace(
    { '/data': new RAMVFS() },
    { mode: MountMode.EXEC, shellParser: await getTestParser(), runtimes: [rt, 'workspace'] },
  )
  try {
    const result = await execute(
      rt,
      [
        "const fd = os.open('/data/z', os.O_RDWR | os.O_CREAT)",
        'const b = new Uint8Array([104, 105]).buffer',
        'console.log(fd, os.write(fd, b, 0, 2), os.seek(fd, 0n, std.SEEK_SET), os.seek(fd, -1, std.SEEK_SET))',
        'const got = new ArrayBuffer(4)',
        "console.log(os.read(fd, got, 0, 4), new Uint8Array(got, 0, 2).join(','), os.close(fd), os.close(fd), os.isatty(fd))",
        "const f = std.open('/data/z', 'r+')",
        'const first = f.getByte()',
        'f.seek(0, std.SEEK_END)',
        'console.log(first, f.putByte(321), f.tell())',
        'f.close()',
        "console.log(std.loadFile('/data/z'))",
      ].join('\n'),
    )
    expect(new TextDecoder().decode(result.stdout)).toBe(
      '4 2 0 -28\n2 104,105 0 -8 false\n104 65 3\nhiA\n',
    )
  } finally {
    await ws.close()
  }
})

describe('QuickJS compatibility', () => {
  it.each([
    [
      'const span = 1; const toIndex = 2; const __join = 3; print(span + toIndex + __join)',
      '6\n',
      '',
      0,
    ],
    [
      "try { std.exit(200) } catch (e) { print('caught') } finally { print('finally') }; print('after')",
      '',
      '',
      200,
    ],
    ["throw 'plain'", '', 'plain\n    at <eval> (<cmdline>:1:6)\n\n', 1],
    ['throw 42', '', '42\n    at <eval> (<cmdline>:1:6)\n\n', 1],
    ['throw new Error()', '', 'Error\n    at <eval> (<cmdline>:1:11)\n\n', 1],
    ["print(std.getenv('toString'))", 'undefined\n', '', 0],
    ["print(std.out.printf('é%s', 'é')); print(std.out.printf('%d', 2**40))", 'éé4\n01\n', '', 0],
    [
      'print(std.in.readAsString(2), std.in.readAsString(1), std.in.readAsString())',
      'ab c def\n',
      '',
      0,
    ],
    [
      "print(atob(btoa('a\\0b')).length, std.Error.ENOENT, os.S_IFIFO); queueMicrotask(() => print('job'))",
      '3 44 4096\njob\n',
      '',
      0,
    ],
  ])('runs %s', async (code, stdout, stderr, exitCode) => {
    const result = await execute(new QuickJsRuntime(), code, {
      stdin: new TextEncoder().encode('abcdef'),
    })
    expect(new TextDecoder().decode(result.stdout)).toBe(stdout)
    expect(new TextDecoder().decode(result.stderr ?? new Uint8Array())).toBe(stderr)
    expect(result.exitCode).toBe(exitCode)
  })
})

// A reader that holds the program's prints back does not hold its deadline
// back: the run still times out.
describe('QuickJS output', () => {
  it('times out while its reader holds the prints back', async () => {
    const rt = new QuickJsRuntime()
    const run = rt.execute(
      [],
      [],
      context({ flags: { c: 'console.log(1); console.log(2)' }, timeoutSeconds: 0.3005 }),
      { output: () => new Promise<void>(() => undefined) },
    )
    await expect(run).rejects.toThrow('timed out')
  }, 10_000)

  it('times out in a queued job while its reader holds the prints back', async () => {
    const rt = new QuickJsRuntime()
    const run = rt.execute(
      [],
      [],
      context({
        flags: { c: 'Promise.resolve().then(() => console.log(1))' },
        timeoutSeconds: 0.3005,
      }),
      { output: () => new Promise<void>(() => undefined) },
    )
    await expect(run).rejects.toThrow('timed out')
  }, 10_000)

  // Input left open does not hold back the stop of a run.
  it('ends without waiting on input it never reads', async () => {
    const rt = new QuickJsRuntime()
    const open: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => undefined) }),
    }
    const result = await rt.execute(
      [],
      [],
      context({ flags: { c: 'console.log(1)' }, stdin: open }),
    )
    expect([new TextDecoder().decode(result.stdout), result.exitCode]).toEqual(['1\n', 0])
  }, 10_000)

  it('stops at an abort while it waits on input that stays open', async () => {
    const rt = new QuickJsRuntime()
    const stop = new AbortController()
    const open: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => undefined) }),
    }
    const run = rt.execute(
      [],
      [],
      context({
        flags: { c: 'console.log(std.in.getline())' },
        stdin: open,
        signal: stop.signal,
      }),
    )
    setTimeout(() => {
      stop.abort()
    }, 100)
    const result = await run
    expect([new TextDecoder().decode(result.stdout), result.exitCode]).toEqual(['', 1])
  }, 10_000)
})
