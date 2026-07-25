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
import { makeWorkspace, stdoutStr } from './fixtures/workspace_fixture.ts'

const ENC = new TextEncoder()

describe('workspace: env builtin', () => {
  it('prints the environment unsorted in insertion order', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute('export ZZZ=1')
    await ws.execute('export AAA=2')
    const io = await ws.execute('env')
    const out = stdoutStr(io)
    expect(out.indexOf('ZZZ=1')).toBeLessThan(out.indexOf('AAA=2'))
    await ws.close()
  })

  it('-i starts from an empty environment', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute('export KEEP=1')
    const io = await ws.execute('env -i A=1 B=2')
    expect(stdoutStr(io)).toBe('A=1\nB=2\n')
    await ws.close()
  })

  it('runs a command under the modified environment', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('env -i FOO=bar printenv FOO')
    expect(stdoutStr(io)).toBe('bar\n')
    await ws.close()
  })

  it('-u removes a variable', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute('export DROP=x')
    await ws.execute('export KEEP=y')
    const io = await ws.execute('env -u DROP')
    const out = stdoutStr(io)
    expect(out).not.toContain('DROP=')
    expect(out).toContain('KEEP=y')
    await ws.close()
  })

  it('-0 terminates entries with NUL', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('env -i -0 A=1 B=2')
    expect(stdoutStr(io)).toBe('A=1\0B=2\0')
    await ws.close()
  })

  it('run form forwards stdin to the command', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('env -i X=1 cat', { stdin: ENC.encode('piped\n') })
    expect(stdoutStr(io)).toBe('piped\n')
    await ws.close()
  })

  it('restores the session environment after the run form', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute('export FOO=original')
    await ws.execute('env -i FOO=temp printenv FOO')
    const io = await ws.execute('printenv FOO')
    expect(stdoutStr(io)).toBe('original\n')
    await ws.close()
  })

  it('rejects an invalid option with exit 125', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('env -Z')
    expect(io.exitCode).toBe(125)
    await ws.close()
  })

  it('treats a lone - as --ignore-environment', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute('export KEEP=x')
    const io = await ws.execute('env - A=1')
    expect(stdoutStr(io)).toBe('A=1\n')
    await ws.close()
  })

  it('rejects -0 combined with a command (exit 125)', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('env -0 echo hi')
    expect(io.exitCode).toBe(125)
    expect(new TextDecoder().decode(io.stderr)).toContain('cannot specify --null (-0) with command')
    await ws.close()
  })
})
