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
import { MountMode, OpsRegistry, RAMResource, Workspace } from '@struktoai/mirage-node'
import { mirageOperations } from './operations.ts'

function mkWs(): Workspace {
  const ram = new RAMResource()
  const ops = new OpsRegistry()
  for (const op of ram.ops()) ops.register(op)
  return new Workspace({ '/': ram }, { mode: MountMode.WRITE, ops })
}

describe('mirageOperations.read', () => {
  it('reads file as Buffer', async () => {
    const ws = mkWs()
    await ws.fs.writeFile('/hello.txt', 'hi')
    const ops = mirageOperations(ws)
    const buf = await ops.read.readFile('/hello.txt')
    expect(Buffer.isBuffer(buf)).toBe(true)
    expect(buf.toString()).toBe('hi')
  })

  it('access throws on missing file', async () => {
    const ops = mirageOperations(mkWs())
    await expect(ops.read.access('/missing.txt')).rejects.toThrow()
  })
})

describe('mirageOperations.write', () => {
  it('writes file content', async () => {
    const ws = mkWs()
    const ops = mirageOperations(ws)
    await ops.write.writeFile('/out.txt', 'data')
    expect(await ws.fs.readFileText('/out.txt')).toBe('data')
  })

  it('mkdir creates nested directories', async () => {
    const ws = mkWs()
    const ops = mirageOperations(ws)
    await ops.write.mkdir('/a/b/c')
    expect(await ws.fs.isDir('/a/b/c')).toBe(true)
  })

  it('mkdir is idempotent', async () => {
    const ws = mkWs()
    const ops = mirageOperations(ws)
    await ops.write.mkdir('/a/b')
    await ops.write.mkdir('/a/b')
    expect(await ws.fs.isDir('/a/b')).toBe(true)
  })
})

describe('mirageOperations.edit', () => {
  it('round-trips read + write', async () => {
    const ws = mkWs()
    await ws.fs.writeFile('/f.txt', 'old')
    const ops = mirageOperations(ws)
    const buf = await ops.edit.readFile('/f.txt')
    await ops.edit.writeFile('/f.txt', `${buf.toString()} + new`)
    expect(await ws.fs.readFileText('/f.txt')).toBe('old + new')
  })

  it('rejects an edit after the file changed since the agent read it', async () => {
    const ws = mkWs()
    await ws.fs.writeFile('/f.txt', 'original')
    const ops = mirageOperations(ws)
    await ops.read.readFile('/f.txt')
    await ws.fs.writeFile('/f.txt', 'changed elsewhere')

    await expect(ops.edit.readFile('/f.txt')).rejects.toThrow(
      'File changed since it was last read: /f.txt',
    )

    await ops.read.readFile('/f.txt')
    expect((await ops.edit.readFile('/f.txt')).toString()).toBe('changed elsewhere')
  })

  it('rejects a write when the file changes while an edit is in progress', async () => {
    const ws = mkWs()
    await ws.fs.writeFile('/f.txt', 'original')
    const ops = mirageOperations(ws)
    await ops.edit.readFile('/f.txt')
    await ws.fs.writeFile('/f.txt', 'changed elsewhere')

    await expect(ops.edit.writeFile('/f.txt', 'replacement')).rejects.toThrow(
      'Read the file again before modifying it',
    )
    expect(await ws.fs.readFileText('/f.txt')).toBe('changed elsewhere')
  })
})

describe('mirageOperations stale write protection', () => {
  it('rejects an overwrite after the file changed since the agent read it', async () => {
    const ws = mkWs()
    await ws.fs.writeFile('/f.txt', 'original')
    const ops = mirageOperations(ws)
    await ops.read.readFile('/f.txt')
    await ws.fs.writeFile('/f.txt', 'changed elsewhere')

    await expect(ops.write.writeFile('/f.txt', 'replacement')).rejects.toThrow(
      'Read the file again before modifying it',
    )
    expect(await ws.fs.readFileText('/f.txt')).toBe('changed elsewhere')
  })

  it('can disable stale write protection', async () => {
    const ws = mkWs()
    await ws.fs.writeFile('/f.txt', 'original')
    const ops = mirageOperations(ws, { staleWriteProtection: false })
    await ops.read.readFile('/f.txt')
    await ws.fs.writeFile('/f.txt', 'changed elsewhere')
    await ops.write.writeFile('/f.txt', 'replacement')
    expect(await ws.fs.readFileText('/f.txt')).toBe('replacement')
  })
})

describe('mirageOperations.bash', () => {
  it('executes echo and reports stdout via onData + exitCode 0', async () => {
    const ops = mirageOperations(mkWs())
    const chunks: Buffer[] = []
    const result = await ops.bash.exec('echo hello', '/', {
      onData: (data) => chunks.push(data),
    })
    expect(result.exitCode).toBe(0)
    expect(Buffer.concat(chunks).toString()).toBe('hello\n')
  })

  it('reports non-zero exit code', async () => {
    const ops = mirageOperations(mkWs())
    const noop = (_: Buffer): void => undefined
    const result = await ops.bash.exec('false', '/', { onData: noop })
    expect(result.exitCode).not.toBe(0)
  })

  it('runs commands from the cwd supplied by Pi', async () => {
    const ws = mkWs()
    await ws.fs.mkdir('/nested')
    const ops = mirageOperations(ws)
    const chunks: Buffer[] = []
    await ops.bash.exec('pwd', '/nested', {
      onData: (data) => chunks.push(data),
    })
    expect(Buffer.concat(chunks).toString()).toBe('/nested\n')
    expect(ws.cwd).toBe('/')
  })

  it('maps Pi cancellation to its expected aborted error', async () => {
    const ops = mirageOperations(mkWs())
    const controller = new AbortController()
    controller.abort()
    await expect(
      ops.bash.exec('echo never', '/', {
        onData: () => undefined,
        signal: controller.signal,
      }),
    ).rejects.toThrow('aborted')
  })

  it('maps Pi timeouts to its expected timeout error', async () => {
    const ops = mirageOperations(mkWs())
    await expect(
      ops.bash.exec('sleep 1', '/', {
        onData: () => undefined,
        timeout: 0.01,
      }),
    ).rejects.toThrow('timeout:0.01')
  })
})

describe('mirageOperations.grep', () => {
  it('isDirectory + readFile', async () => {
    const ws = mkWs()
    await ws.fs.writeFile('/a.txt', 'alpha\nbeta\n')
    const ops = mirageOperations(ws)
    expect(await ops.grep.isDirectory('/')).toBe(true)
    expect(await ops.grep.isDirectory('/a.txt')).toBe(false)
    expect(await ops.grep.readFile('/a.txt')).toBe('alpha\nbeta\n')
  })
})

describe('mirageOperations.find', () => {
  it('glob walks workspace and matches pattern', async () => {
    const ws = mkWs()
    await ws.fs.writeFile('/a.ts', 'x')
    await ws.fs.mkdir('/sub')
    await ws.fs.writeFile('/sub/b.ts', 'y')
    await ws.fs.writeFile('/sub/c.txt', 'z')
    const ops = mirageOperations(ws)
    const matches = await ops.find.glob('**/*.ts', '/', { ignore: [], limit: 100 })
    expect(matches.sort()).toEqual(['/a.ts', '/sub/b.ts'])
  })

  it('glob respects limit', async () => {
    const ws = mkWs()
    await ws.fs.writeFile('/a.ts', 'x')
    await ws.fs.writeFile('/b.ts', 'y')
    await ws.fs.writeFile('/c.ts', 'z')
    const ops = mirageOperations(ws)
    const matches = await ops.find.glob('**/*.ts', '/', { ignore: [], limit: 2 })
    expect(matches.length).toBe(2)
  })

  it('glob honors ignore patterns', async () => {
    const ws = mkWs()
    await ws.fs.writeFile('/keep.ts', 'x')
    await ws.fs.mkdir('/skip')
    await ws.fs.writeFile('/skip/y.ts', 'y')
    const ops = mirageOperations(ws)
    const matches = await ops.find.glob('**/*.ts', '/', {
      ignore: ['skip/**', 'skip'],
      limit: 100,
    })
    expect(matches).toEqual(['/keep.ts'])
  })

  it('exists', async () => {
    const ws = mkWs()
    await ws.fs.writeFile('/x.txt', 'x')
    const ops = mirageOperations(ws)
    expect(await ops.find.exists('/x.txt')).toBe(true)
    expect(await ops.find.exists('/nope.txt')).toBe(false)
  })
})

describe('mirageOperations.ls', () => {
  it('exists + stat + readdir', async () => {
    const ws = mkWs()
    await ws.fs.mkdir('/d')
    await ws.fs.writeFile('/d/x.txt', 'x')
    await ws.fs.writeFile('/d/y.txt', 'y')
    const ops = mirageOperations(ws)
    expect(await ops.ls.exists('/d')).toBe(true)
    const stat = await ops.ls.stat('/d')
    expect(stat.isDirectory()).toBe(true)
    const entries = await ops.ls.readdir('/d')
    expect(entries.sort()).toEqual(['x.txt', 'y.txt'])
  })
})
