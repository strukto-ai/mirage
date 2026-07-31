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

  it('std.out.puts writes raw, print appends a newline (real qjs)', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute("js -e \"std.out.puts('a'); std.out.puts('b'); print('c')\"")
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe('abc\n')
    await ws.close()
  }, 60_000)

  it('console.log ToStrings its args like the real engine, not JSON', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('js -e "console.log({a: 1}, [1, 2])"')
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe('[object Object] 1,2\n')
    await ws.close()
  }, 60_000)

  it('console.error does not exist, matching quickjs-ng --std', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('js -e "console.error(\'x\')"')
    expect(io.exitCode).toBe(1)
    expect(stderrStr(io)).toContain('TypeError')
    await ws.close()
  }, 60_000)

  it('std.out.printf C-formats and returns the characters written', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute(
      "js -e \"const n = std.out.printf('[%s|%05d|%.2f|%x|%c|%%]', 'ab', 42, 3.14159, 255, 65); std.out.puts('\\n' + n)\"",
    )
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe('[ab|00042|3.14|ff|A|%]\n22')
    await ws.close()
  }, 60_000)

  it('printf covers the C conversions, pinned against the real engine', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute(
      'js -e "std.out.printf(\'e[%e]g[%g]plus[%+d]hash[%#x]prec[%.3d]sp[% d]E[%E]G[%G]\', 1234.5678, 1234.5678, 42, 255, 7, 9, 1234.5678, 0.00012)"',
    )
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe(
      'e[1.234568e+03]g[1234.57]plus[+42]hash[0xff]prec[007]sp[ 9]E[1.234568E+03]G[0.00012]',
    )
    await ws.close()
  }, 60_000)

  it('printf star width and precision consume their arguments', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute(
      "js -e \"std.out.printf('star[%*d]prec[%.*f]o[%#o]neg[%05d]s[%.3s]c[%c]', 6, 42, 2, 3.14159, 8, -42, 'abcdef', 'zz')\"",
    )
    expect(io.exitCode).toBe(0)
    expect(stdoutStr(io)).toBe('star[    42]prec[3.14]o[010]neg[-0042]s[abc]c[z]')
    await ws.close()
  }, 60_000)

  it('printf throws TypeError on an unknown conversion, like the real engine', async () => {
    const { ws } = await makeWorkspace()
    const io = await ws.execute('js -e "std.out.printf(\'%q\', 1)"')
    expect(io.exitCode).toBe(1)
    expect(stderrStr(io)).toContain('TypeError: invalid conversion specifier in format string')
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
