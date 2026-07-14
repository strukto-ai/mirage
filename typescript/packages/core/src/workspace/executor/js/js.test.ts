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
import { makeWorkspace, stderrStr, stdoutStr } from '../../fixtures/workspace_fixture.ts'

// Mirrors the Python `node`/`js` command tests; both run on quickjs so a
// script behaves identically across languages.
describe('node/js: quickjs runtime', () => {
  it('js -e: modern syntax + compute', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute(
      'js -e "console.log(6 * 7, JSON.stringify([...\'ab\'].map((s, i) => s + i)))"',
    )
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe('42 ["a0","b1"]\n')
    await ws.close()
  }, 60_000)

  it('node -e: scriptArgs', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('node -e "console.log(scriptArgs.join(\'/\'))" a b')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe('a/b\n')
    await ws.close()
  }, 60_000)

  it('stdin pipe: std.in.readAsString()', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute(
      'echo hello | js -e "console.log(std.in.readAsString().trim().toUpperCase())"',
    )
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe('HELLO\n')
    await ws.close()
  }, 60_000)

  it('-m: module mode with top-level await', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute(
      'js -m -e "const x = await Promise.resolve(41); console.log(x + 1)"',
    )
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe('42\n')
    await ws.close()
  }, 60_000)

  it('mounted .js file resolves through the workspace', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute("echo 'console.log(Number(scriptArgs[0]) * 6)' > /ram/calc.js")
    const io = await ws.execute('node /ram/calc.js 7')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe('42\n')
    await ws.close()
  }, 60_000)

  it('mounted .mjs file runs in module mode', async () => {
    const { ws } = await makeWorkspace()
    await ws.execute(
      "printf 'const k = await Promise.resolve(5);\\nconsole.log(k * 2)\\n' > /ram/mod.mjs",
    )
    const io = await ws.execute('node /ram/mod.mjs')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe('10\n')
    await ws.close()
  }, 60_000)

  it('syntax error → exit 1 on stderr', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('js -e "this is not js"')
    expect(io.exitCode).toBe(1)
    expect(stderrStr(io)).toContain('SyntaxError')
    await ws.close()
  }, 60_000)

  it('sandboxed: no node builtins', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('js -e "console.log(typeof process, typeof require, typeof fetch)"')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe('undefined undefined undefined\n')
    await ws.close()
  }, 60_000)

  it('no input → exit 1', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('js')
    expect(io.exitCode).toBe(1)
    expect(stderrStr(io)).toContain('js: no input')
    await ws.close()
  }, 60_000)
})
