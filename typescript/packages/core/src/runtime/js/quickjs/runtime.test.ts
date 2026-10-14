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
import { getTestParser } from '../../../workspace/fixtures/workspace_fixture.ts'

describe('QuickJS cwd', () => {
  it('inherits the captured cwd and honors an explicit one', async () => {
    const rt = new QuickJsRuntime()
    const ws = new Workspace(
      { '/data': new RAMVFS() },
      {
        mode: MountMode.EXEC,
        shellParser: await getTestParser(),
        runtimes: [rt, 'workspace'],
      },
    )
    const args = { code: 'console.log(os.getcwd()[0])', args: [], env: {}, stdin: null }
    const dec = new TextDecoder()
    try {
      expect(
        (await ws.shell('mkdir /data/sub; echo child > /data/sub/item; cd /data')).exitCode,
      ).toBe(0)
      expect(dec.decode((await rt.run(args)).stdout)).toBe('/data\n')
      expect(
        dec.decode((await rt.run({ ...args, cwd: PathSpec.fromStrPath('/data/sub') })).stdout),
      ).toBe('/data/sub\n')
      const bad = await rt.run({
        ...args,
        code: "console.log('must not run')",
        cwd: PathSpec.fromStrPath('/missing'),
      })
      expect(bad.exitCode).toBe(1)
      expect(dec.decode(bad.stdout)).toBe('')
      expect(dec.decode(bad.stderr ?? new Uint8Array())).toContain('cannot change directory')
      expect(dec.decode((await rt.run(args)).stdout)).toBe('/data\n')
    } finally {
      await ws.close()
    }
  })
})

it('marks a FILE whose flush failed as in error', async () => {
  const full = (): Promise<void> =>
    Promise.reject(Object.assign(new Error('no space'), { code: 'ENOSPC' }))
  class FullVFS extends RAMVFS {
    override append = full
    override pwrite = full
    override write = full
  }
  const rt = new QuickJsRuntime()
  const ws = new Workspace(
    { '/data': new FullVFS() },
    { mode: MountMode.EXEC, shellParser: await getTestParser(), runtimes: [rt, 'workspace'] },
  )
  try {
    const result = await rt.run({
      code: "const f = std.open('/data/x', 'w'); f.puts('x'); print(String(f.flush()), f.error())",
      args: [],
      env: {},
      stdin: null,
    })
    expect(new TextDecoder().decode(result.stdout)).toBe('undefined true\n')
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
    ["throw 'plain'", '', 'plain\n', 1],
    ['throw 42', '', '42\n', 1],
    ['throw new Error()', '', 'Error\n', 1],
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
    const result = await new QuickJsRuntime().run({
      code,
      args: [],
      env: {},
      stdin: new TextEncoder().encode('abcdef'),
    })
    expect(new TextDecoder().decode(result.stdout)).toBe(stdout)
    expect(new TextDecoder().decode(result.stderr ?? new Uint8Array())).toBe(stderr)
    expect(result.exitCode).toBe(exitCode)
  })
})
