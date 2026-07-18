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
import { makeWorkspace } from '../../fixtures/workspace_fixture.ts'

const DEC = new TextDecoder()
const stdout = (r: { stdout: Uint8Array }): string => DEC.decode(r.stdout)
const stderr = (r: { stderr: Uint8Array | null }): string =>
  r.stderr === null ? '' : DEC.decode(r.stderr)

describe('Workspace.executePythonRepl', () => {
  it('prints the value of the last expression (single-mode behavior)', async () => {
    const { ws } = await makeWorkspace()
    const r = await ws.executePythonRepl('1 + 2')
    expect(r.status).toBe('complete')
    expect(r.exitCode).toBe(0)
    expect(stdout(r)).toBe('3\n')
    await ws.close()
  }, 60_000)

  it('persists state across calls in the same session', async () => {
    const { ws } = await makeWorkspace()
    const r1 = await ws.executePythonRepl('x = 41')
    expect(r1.status).toBe('complete')
    const r2 = await ws.executePythonRepl('x + 1')
    expect(r2.status).toBe('complete')
    expect(stdout(r2)).toBe('42\n')
    await ws.close()
  })

  it('isolates state between distinct sessions', async () => {
    const { ws } = await makeWorkspace()
    await ws.executePythonRepl('x = 1', { sessionId: 'a' })
    const r = await ws.executePythonRepl('x', { sessionId: 'b' })
    expect(r.exitCode).toBe(1)
    expect(stderr(r)).toContain('NameError')
    await ws.close()
  })

  it('reports incomplete for unclosed blocks', async () => {
    const { ws } = await makeWorkspace()
    const r = await ws.executePythonRepl('def f(x):')
    expect(r.status).toBe('incomplete')
    expect(r.exitCode).toBe(0)
    expect(stdout(r)).toBe('')
    expect(stderr(r)).toBe('')
    await ws.close()
  })

  it('runs a multi-line def submitted as one buffer, then calls it', async () => {
    const { ws } = await makeWorkspace()
    const r1 = await ws.executePythonRepl('def f(x):\n    return x * 2\n')
    expect(r1.status).toBe('complete')
    const r2 = await ws.executePythonRepl('f(21)')
    expect(r2.status).toBe('complete')
    expect(stdout(r2)).toBe('42\n')
    await ws.close()
  })

  it('reports SyntaxError as complete with stderr (not as incomplete)', async () => {
    const { ws } = await makeWorkspace()
    const r = await ws.executePythonRepl('def (x): bad')
    expect(r.status).toBe('complete')
    expect(r.exitCode).toBe(1)
    expect(stderr(r)).toContain('SyntaxError')
    await ws.close()
  })

  it('exit() returns status=exit with exitCode 0', async () => {
    const { ws } = await makeWorkspace()
    const r = await ws.executePythonRepl('exit()')
    expect(r.status).toBe('exit')
    expect(r.exitCode).toBe(0)
    await ws.close()
  })

  it('exit(2) returns status=exit with exitCode 2', async () => {
    const { ws } = await makeWorkspace()
    const r = await ws.executePythonRepl('exit(2)')
    expect(r.status).toBe('exit')
    expect(r.exitCode).toBe(2)
    await ws.close()
  })

  it('uncaught exception shows traceback, exitCode 1, status complete', async () => {
    const { ws } = await makeWorkspace()
    const r = await ws.executePythonRepl('1 / 0')
    expect(r.status).toBe('complete')
    expect(r.exitCode).toBe(1)
    expect(stderr(r)).toContain('ZeroDivisionError')
    await ws.close()
  })

  it('imports persist across calls within a session', async () => {
    const { ws } = await makeWorkspace()
    await ws.executePythonRepl('import json')
    const r = await ws.executePythonRepl('json.dumps({"a": 1})')
    expect(r.status).toBe('complete')
    expect(stdout(r)).toContain('"a": 1')
    await ws.close()
  })
})
