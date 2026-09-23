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
import { OpsRegistry } from '@struktoai/mirage-core/ops/registry'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { MountMode } from '@struktoai/mirage-core/types'
import { Workspace } from '@struktoai/mirage-node'
import { mirageTools } from './index.ts'

function mkWs(): Workspace {
  const ram = new RAMVFS()
  const ops = new OpsRegistry()
  for (const op of ram.ops()) ops.register(op)
  return new Workspace({ '/': ram }, { mode: MountMode.WRITE, ops })
}

async function runTool<T>(t: unknown, input: unknown): Promise<T> {
  const exec = (t as { execute?: (input: unknown, ctx: unknown) => unknown }).execute
  if (typeof exec !== 'function') throw new Error('tool has no execute')
  return (await exec(input, {})) as T
}

describe('mastra mirageTools.execute', () => {
  it('runs a shell command and returns stdout/stderr/exitCode', async () => {
    const tools = mirageTools(mkWs())
    const r = await runTool<{ stdout: string; stderr: string; exitCode: number }>(tools.execute, {
      command: 'echo hello',
    })
    expect(r.stdout).toBe('hello\n')
    expect(r.stderr).toBe('')
    expect(r.exitCode).toBe(0)
  })

  it('captures non-zero exit code', async () => {
    const r = await runTool<{ stdout: string; stderr: string; exitCode: number }>(
      mirageTools(mkWs()).execute,
      { command: 'cat /nope.txt' },
    )
    expect(r.exitCode).not.toBe(0)
    expect(r.stderr.length).toBeGreaterThan(0)
  })

  it('exposes a stable tool id', () => {
    const tools = mirageTools(mkWs()) as unknown as { execute: { id: string } }
    expect(tools.execute.id).toBe('mirage-execute')
  })
})

describe('mastra mirageTools.readFile', () => {
  it('reads file content as text', async () => {
    const ws = mkWs()
    await ws.vfs.writeFile('/notes.txt', 'hello')
    const r = await runTool<{ content: string }>(mirageTools(ws).readFile, { path: '/notes.txt' })
    expect(r.content).toBe('hello')
  })

  it('returns error for missing file', async () => {
    const r = await runTool<{ error: string; content: string }>(mirageTools(mkWs()).readFile, {
      path: '/missing.txt',
    })
    expect(r.error.length).toBeGreaterThan(0)
  })
})

describe('mastra mirageTools.writeFile', () => {
  it('creates a new file with content', async () => {
    const ws = mkWs()
    const r = await runTool<{ path: string }>(mirageTools(ws).writeFile, {
      path: '/out.txt',
      content: 'data',
    })
    expect(r.path).toBe('/out.txt')
    expect(await ws.vfs.readFileText('/out.txt')).toBe('data')
  })

  it('mkdirs missing parent directories', async () => {
    const ws = mkWs()
    const r = await runTool<{ path: string }>(mirageTools(ws).writeFile, {
      path: '/a/b/c.txt',
      content: 'x',
    })
    expect(r.path).toBe('/a/b/c.txt')
    expect(await ws.vfs.readFileText('/a/b/c.txt')).toBe('x')
  })
})

describe('mastra mirageTools.editFile', () => {
  it('replaces single occurrence', async () => {
    const ws = mkWs()
    await ws.vfs.writeFile('/f.txt', 'foo bar baz')
    const r = await runTool<{ occurrences: number }>(mirageTools(ws).editFile, {
      path: '/f.txt',
      oldString: 'bar',
      newString: 'BAR',
    })
    expect(r.occurrences).toBe(1)
    expect(await ws.vfs.readFileText('/f.txt')).toBe('foo BAR baz')
  })

  it('rejects multiple occurrences without replaceAll', async () => {
    const ws = mkWs()
    await ws.vfs.writeFile('/f.txt', 'aa aa')
    const r = await runTool<{ error: string }>(mirageTools(ws).editFile, {
      path: '/f.txt',
      oldString: 'aa',
      newString: 'X',
    })
    expect(r.error).toContain('appears 2 times')
  })

  it('replaces all when replaceAll is true', async () => {
    const ws = mkWs()
    await ws.vfs.writeFile('/f.txt', 'aa aa')
    const r = await runTool<{ occurrences: number }>(mirageTools(ws).editFile, {
      path: '/f.txt',
      oldString: 'aa',
      newString: 'X',
      replaceAll: true,
    })
    expect(r.occurrences).toBe(2)
    expect(await ws.vfs.readFileText('/f.txt')).toBe('X X')
  })
})

describe('mastra mirageTools.ls', () => {
  it('lists entries with is_dir flags', async () => {
    const ws = mkWs()
    await ws.vfs.writeFile('/a.txt', 'a')
    await ws.vfs.mkdir('/d')
    const r = await runTool<{ files: { path: string; is_dir: boolean }[] }>(mirageTools(ws).ls, {
      path: '/',
    })
    const paths = r.files.map((f) => f.path).sort()
    expect(paths).toContain('/a.txt')
    expect(paths).toContain('/d')
    expect(r.files.find((f) => f.path === '/d')?.is_dir).toBe(true)
    expect(r.files.find((f) => f.path === '/a.txt')?.is_dir).toBe(false)
  })
})
