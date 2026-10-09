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
import { PathSpec } from '../../types.ts'
import type { RunArgs } from '../types.ts'
import { mainFilename, prepareSource } from './execution.ts'

function script(raw: string, virtual: string): PathSpec {
  return new PathSpec({
    virtual,
    directory: virtual.slice(0, virtual.lastIndexOf('/') + 1),
    vfsPath: virtual.replace(/^\/+/, ''),
    rawPath: raw,
  })
}

function run(opts: { code?: string; prog?: string; script?: PathSpec; cwd?: string }): RunArgs {
  return {
    code: opts.code ?? 'print(1)',
    args: [],
    env: {},
    stdin: null,
    ...(opts.prog !== undefined ? { prog: opts.prog } : {}),
    ...(opts.script !== undefined ? { scriptPath: opts.script } : {}),
    ...(opts.cwd !== undefined ? { cwd: PathSpec.fromStrPath(opts.cwd) } : {}),
  }
}

// Mirrors Python's tests/runtime/python/test_execution.py.
describe('prepareSource', () => {
  it.each([undefined, '-c'])('passes a payload through untouched (prog %s)', (prog) => {
    expect(prepareSource(run(prog !== undefined ? { prog } : {}))).toBe('print(1)')
  })

  it.each([
    ['/w/s.py', '/', '/w/s.py'],
    ['s.py', '/w', '/w/s.py'],
    ['./app/s.py', '/w', '/w/./app/s.py'],
    ['../w/s.py', '/w', '/w/../w/s.py'],
    ['w/s.py', '/', '/w/s.py'],
  ])('names %s under %s as typed against the cwd', (raw, cwd, name) => {
    // CPython 3.13.5: absolute against the working directory, never
    // normalized, whatever the spelling.
    expect(mainFilename(run({ prog: raw, script: script(raw, '/w/s.py'), cwd }))).toBe(name)
  })

  it('sets argv[0] and __file__ and compiles a script under its own name', () => {
    const out = prepareSource(run({ prog: 's.py', script: script('s.py', '/w/s.py'), cwd: '/w' }))
    expect(out).toContain(`argv[0] = "s.py"`)
    expect(out).toContain(`__file__ = "/w/s.py"`)
    expect(out).toContain(`, "/w/s.py", 'exec')`)
  })

  it.each(['', '-'])('compiles both stdin entry points as <stdin> (prog %j)', (prog) => {
    const out = prepareSource(run({ prog }))
    expect(out).toContain(`, "<stdin>", 'exec')`)
    expect(out).toContain(`__file__ = "<stdin>"`)
    expect(out).toContain(`argv[0] = ${JSON.stringify(prog)}`)
  })

  it('names no file for a module', () => {
    const out = prepareSource(run({ prog: 'json.tool' }))
    expect(out).toContain(`, "json.tool", 'exec')`)
    expect(out).not.toContain('__file__')
  })
})
