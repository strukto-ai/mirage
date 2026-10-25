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
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { Limit, MountMode } from '@struktoai/mirage-core/types'
import { Workspace } from '@struktoai/mirage-node'
import { parseSessionProfile } from '@struktoai/mirage-core/policy/profile'
import { LangchainWorkspace } from './backend.ts'

const DEC = new TextDecoder()
const ENC = new TextEncoder()

function mkWs(): Workspace {
  const ram = new RAMVFS()
  return new Workspace({ '/': ram }, { mode: MountMode.WRITE })
}

describe('LangchainWorkspace.id', () => {
  it('defaults to "mirage"', () => {
    const lw = new LangchainWorkspace(mkWs())
    expect(lw.id).toBe('mirage')
  })

  it('accepts custom sandboxId', () => {
    const lw = new LangchainWorkspace(mkWs(), { sandboxId: 'custom' })
    expect(lw.id).toBe('custom')
  })
})

describe('LangchainWorkspace.execute', () => {
  it('runs a command and returns ExecuteResponse', async () => {
    const lw = new LangchainWorkspace(mkWs())
    const r = await lw.execute('echo hello')
    expect(r.output).toBe('hello\n')
    expect(r.exitCode).toBe(0)
    expect(r.truncated).toBe(false)
  })
})

describe('LangchainWorkspace.write', () => {
  it('creates new file', async () => {
    const ws = mkWs()
    const lw = new LangchainWorkspace(ws)
    const r = await lw.write('/hello.txt', 'hi')
    expect(r.error).toBeUndefined()
    expect(r.path).toBe('/hello.txt')
    expect(DEC.decode(await ws.vfs.read('/hello.txt'))).toBe('hi')
  })

  it('rejects existing path', async () => {
    const ws = mkWs()
    await ws.vfs.write('/exists.txt', 'x')
    const lw = new LangchainWorkspace(ws)
    const r = await lw.write('/exists.txt', 'new')
    expect(r.error).toContain('already exists')
    expect(r.path).toBeUndefined()
  })

  it('mkdirs missing parent', async () => {
    const ws = mkWs()
    const lw = new LangchainWorkspace(ws)
    const r = await lw.write('/sub/nested.txt', 'x')
    expect(r.error).toBeUndefined()
    expect(DEC.decode(await ws.vfs.read('/sub/nested.txt'))).toBe('x')
  })
})

describe('LangchainWorkspace.read', () => {
  it('returns content from existing file', async () => {
    const ws = mkWs()
    await ws.vfs.write('/notes.txt', 'one\ntwo\nthree\n')
    const lw = new LangchainWorkspace(ws)
    const r = await lw.read('/notes.txt')
    expect(r.error).toBeUndefined()
    expect(r.content).toBe('one\ntwo\nthree\n')
    expect(r.mimeType).toBe('text/plain')
  })

  it('honors offset and limit', async () => {
    const ws = mkWs()
    await ws.vfs.write('/n.txt', 'a\nb\nc\nd\n')
    const lw = new LangchainWorkspace(ws)
    const r = await lw.read('/n.txt', 1, 2)
    expect(r.content).toBe('b\nc')
    expect([r.totalLines, r.startLine, r.endLine, r.nextOffset]).toEqual([4, 2, 3, 3])
  })

  it('leaves nextOffset off the last window', async () => {
    const ws = mkWs()
    await ws.vfs.write('/n.txt', 'a\nb\nc\n')
    const r = await new LangchainWorkspace(ws).read('/n.txt', 1)
    expect(r.content).toBe('b\nc\n')
    expect([r.startLine, r.endLine, r.nextOffset]).toEqual([2, 3, undefined])
  })

  it('reports an offset past the end', async () => {
    const ws = mkWs()
    await ws.vfs.write('/n.txt', 'a\nb\n')
    const r = await new LangchainWorkspace(ws).read('/n.txt', 2)
    expect(r.error).toBe('Line offset 2 exceeds file length (2 lines)')
  })

  it('returns error for missing file', async () => {
    const lw = new LangchainWorkspace(mkWs())
    const r = await lw.read('/nope.txt')
    expect(r.error).toBeDefined()
    expect(r.content).toBeUndefined()
  })

  it('returns Uint8Array for application/pdf', async () => {
    const ws = mkWs()
    await ws.vfs.write('/x.pdf', new Uint8Array([0x25, 0x50, 0x44, 0x46]))
    const r = await new LangchainWorkspace(ws).read('/x.pdf')
    expect(r.error).toBeUndefined()
    expect(r.content).toBeInstanceOf(Uint8Array)
    expect(r.mimeType).toBe('application/pdf')
  })

  it('returns Uint8Array for supported image mimes', async () => {
    const ws = mkWs()
    await ws.vfs.write('/x.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
    const r = await new LangchainWorkspace(ws).read('/x.png')
    expect(r.content).toBeInstanceOf(Uint8Array)
    expect(r.mimeType).toBe('image/png')
  })

  it('refuses unsupported binary mimes with shell-redirect error', async () => {
    const ws = mkWs()
    await ws.vfs.write('/x.bin', new Uint8Array([0x00, 0x01, 0x02, 0x03]))
    const r = await new LangchainWorkspace(ws).read('/x.bin')
    expect(r.content).toBeUndefined()
    expect(r.error).toBeDefined()
    expect(r.error).toMatch(/binary/i)
    expect(r.error).toMatch(/execute|head|shell/i)
  })

  it.each(['/x.parquet', '/x.h5', '/x.hdf5', '/x.feather'])(
    'redirects %s to the shell now that no renderer is registered',
    async (path) => {
      const ws = mkWs()
      await ws.vfs.write(path, new Uint8Array([0x00, 0x01, 0x02, 0x03]))
      const r = await new LangchainWorkspace(ws).read(path)
      // Mirage ships no filetype renderers, so these read back as raw bytes.
      // Claiming text/plain would hand the model binary decoded as UTF-8.
      expect(r.content).toBeUndefined()
      expect(r.error).toMatch(/binary/i)
    },
  )
})

describe('LangchainWorkspace.edit', () => {
  it('replaces single occurrence', async () => {
    const ws = mkWs()
    await ws.vfs.write('/f.txt', 'foo bar baz')
    const lw = new LangchainWorkspace(ws)
    const r = await lw.edit('/f.txt', 'bar', 'BAR')
    expect(r.error).toBeUndefined()
    expect(r.occurrences).toBe(1)
    expect(DEC.decode(await ws.vfs.read('/f.txt'))).toBe('foo BAR baz')
  })

  it('keeps a leading BOM', async () => {
    const ws = mkWs()
    await ws.vfs.write('/f.txt', '\ufefffoo bar baz')
    const lw = new LangchainWorkspace(ws)
    const r = await lw.edit('/f.txt', 'bar', 'BAR')
    expect(r.error).toBeUndefined()
    expect(Array.from(await ws.vfs.read('/f.txt'))).toEqual(
      Array.from(ENC.encode('\ufefffoo BAR baz')),
    )
  })

  it('rejects multiple occurrences without replaceAll', async () => {
    const ws = mkWs()
    await ws.vfs.write('/f.txt', 'aa aa')
    const lw = new LangchainWorkspace(ws)
    const r = await lw.edit('/f.txt', 'aa', 'X')
    expect(r.error).toContain('appears 2 times')
  })

  it('replaces all when replaceAll=true', async () => {
    const ws = mkWs()
    await ws.vfs.write('/f.txt', 'aa aa')
    const lw = new LangchainWorkspace(ws)
    const r = await lw.edit('/f.txt', 'aa', 'X', true)
    expect(r.occurrences).toBe(2)
    expect(DEC.decode(await ws.vfs.read('/f.txt'))).toBe('X X')
  })

  it('returns error for missing file', async () => {
    const lw = new LangchainWorkspace(mkWs())
    const r = await lw.edit('/nope.txt', 'x', 'y')
    expect(r.error).toContain('not found')
  })

  it('returns error when string not in file', async () => {
    const ws = mkWs()
    await ws.vfs.write('/f.txt', 'abc')
    const lw = new LangchainWorkspace(ws)
    const r = await lw.edit('/f.txt', 'zzz', 'y')
    expect(r.error).toContain('not found')
  })
})

describe('LangchainWorkspace.ls', () => {
  it('lists files and directories with is_dir flag', async () => {
    const ws = mkWs()
    await ws.vfs.write('/a.txt', 'a')
    await ws.vfs.mkdir('/d')
    await ws.vfs.write('/d/b.txt', 'b')
    const lw = new LangchainWorkspace(ws)
    const r = await lw.ls('/')
    expect(r.error).toBeUndefined()
    const files = r.files ?? []
    const paths = files.map((i) => i.path).sort()
    expect(paths).toContain('/a.txt')
    expect(paths).toContain('/d')
    const dirEntry = files.find((i) => i.path === '/d')
    expect(dirEntry?.is_dir).toBe(true)
    const fileEntry = files.find((i) => i.path === '/a.txt')
    expect(fileEntry?.is_dir).toBe(false)
  })

  it('handles paths with single quotes via shellQuote', async () => {
    const ws = mkWs()
    await ws.vfs.mkdir("/it's a dir")
    await ws.vfs.write("/it's a dir/file.txt", 'x')
    const lw = new LangchainWorkspace(ws)
    const r = await lw.ls("/it's a dir")
    const paths = (r.files ?? []).map((i) => i.path)
    expect(paths).toContain("/it's a dir/file.txt")
  })
})

describe('LangchainWorkspace.glob', () => {
  it('finds files matching a pattern', async () => {
    const ws = mkWs()
    await ws.vfs.write('/a.csv', 'a')
    await ws.vfs.write('/b.csv', 'b')
    await ws.vfs.write('/c.txt', 'c')
    const lw = new LangchainWorkspace(ws)
    const r = await lw.glob('*.csv', '/')
    const paths = (r.files ?? []).map((i) => i.path).sort()
    expect(paths).toContain('/a.csv')
    expect(paths).toContain('/b.csv')
    expect(paths).not.toContain('/c.txt')
  })

  it.each([
    ['*.ts', ['/src/top.ts']],
    ['app/*.ts', ['/src/app/main.ts']],
    ['**/*.ts', ['/src/app/main.ts', '/src/top.ts']],
    ['**/.env', ['/src/.env']],
    ['app', []],
  ])('matches %s against the path under the root, files only', async (pattern, expected) => {
    const ws = mkWs()
    await ws.vfs.mkdir('/src')
    await ws.vfs.write('/src/top.ts', 't')
    await ws.vfs.write('/src/.env', 'e')
    await ws.vfs.mkdir('/src/app')
    await ws.vfs.write('/src/app/main.ts', 'm')
    const r = await new LangchainWorkspace(ws).glob(pattern, '/src')
    expect(r.error).toBeUndefined()
    expect((r.files ?? []).map((i) => i.path).sort()).toEqual(expected)
  })

  it('matches under a root spelled with trailing slashes', async () => {
    const ws = mkWs()
    await ws.vfs.mkdir('/src')
    await ws.vfs.mkdir('/src/app')
    await ws.vfs.write('/src/app/main.ts', 'm')
    const r = await new LangchainWorkspace(ws).glob('app/*.ts', '/src//')
    expect((r.files ?? []).map((i) => i.path)).toEqual(['/src/app/main.ts'])
  })

  it('reports a listing the output cap cut short as truncated', async () => {
    const ws = new Workspace(
      { '/': new RAMVFS() },
      {
        mode: MountMode.WRITE,
        commandLimits: { find: new Limit({ maxLines: 1 }), grep: new Limit({ maxLines: 1 }) },
      },
    )
    await ws.vfs.mkdir('/src')
    await ws.vfs.write('/src/a.txt', 'needle')
    await ws.vfs.write('/src/b.ts', 'needle')
    const lw = new LangchainWorkspace(ws)
    expect((await lw.glob('*.ts', '/src')).truncated).toBe(true)
    const grep = await lw.grep('needle', '/src')
    expect(grep.truncated).toBe(true)
    expect(grep.matches).toHaveLength(1)
  })

  it('reports a missing root', async () => {
    const r = await new LangchainWorkspace(mkWs()).glob('*.ts', '/missing')
    expect(r.files).toBeUndefined()
    expect(r.error).toBeDefined()
  })
})

describe('LangchainWorkspace.delete', () => {
  it('removes a file and a tree', async () => {
    const ws = mkWs()
    await ws.vfs.write('/one.txt', '1')
    await ws.vfs.mkdir('/tree')
    await ws.vfs.mkdir('/tree/a')
    await ws.vfs.write('/tree/a/b.txt', 'b')
    const lw = new LangchainWorkspace(ws)
    expect(await lw.delete('/one.txt')).toEqual({ path: '/one.txt' })
    expect(await lw.delete('/tree')).toEqual({ path: '/tree' })
    expect(await ws.vfs.exists('/one.txt')).toBe(false)
    expect(await ws.vfs.exists('/tree')).toBe(false)
  })

  it('reports a missing path', async () => {
    const r = await new LangchainWorkspace(mkWs()).delete('/missing')
    expect(r.path).toBeUndefined()
    expect(r.error).toBeDefined()
  })
})

describe('LangchainWorkspace.grep', () => {
  it('returns matches with line numbers', async () => {
    const ws = mkWs()
    await ws.vfs.write('/log.txt', 'one\nerror here\ntwo\nerror again\n')
    const lw = new LangchainWorkspace(ws)
    const r = await lw.grep('error', '/log.txt')
    expect(r.error).toBeUndefined()
    const matches = r.matches ?? []
    expect(matches.length).toBe(2)
    expect(matches[0]?.path).toBe('/log.txt')
    expect(matches[0]?.line).toBe(2)
    expect(matches[0]?.text).toContain('error here')
  })

  it('returns empty matches for no hits', async () => {
    const ws = mkWs()
    await ws.vfs.write('/log.txt', 'no match\n')
    const lw = new LangchainWorkspace(ws)
    const r = await lw.grep('zzz', '/log.txt')
    expect(r.matches).toEqual([])
  })

  it('caps at maxCount across files and flags the rest as truncated', async () => {
    const ws = mkWs()
    await ws.vfs.write('/a.txt', 'hit\nhit\n')
    await ws.vfs.write('/b.txt', 'hit\n')
    const lw = new LangchainWorkspace(ws)
    const r = await lw.grep('hit', '/', null, 2)
    expect(r.matches?.length).toBe(2)
    expect(r.truncated).toBe(true)
  })

  it('lands on maxCount exactly without flagging truncation', async () => {
    const ws = mkWs()
    await ws.vfs.write('/a.txt', 'hit\nhit\n')
    const lw = new LangchainWorkspace(ws)
    const r = await lw.grep('hit', '/', null, 2)
    expect(r.matches?.length).toBe(2)
    expect(r.truncated).toBeUndefined()
  })
})

describe('LangchainWorkspace.uploadFiles / downloadFiles', () => {
  it('upload writes files', async () => {
    const ws = mkWs()
    const lw = new LangchainWorkspace(ws)
    const responses = await lw.uploadFiles([
      ['/up1.txt', new TextEncoder().encode('one')],
      ['/up2.txt', new TextEncoder().encode('two')],
    ])
    expect(responses).toHaveLength(2)
    expect(responses[0]?.error).toBeNull()
    expect(DEC.decode(await ws.vfs.read('/up1.txt'))).toBe('one')
    expect(DEC.decode(await ws.vfs.read('/up2.txt'))).toBe('two')
  })

  it('download returns content for existing files', async () => {
    const ws = mkWs()
    await ws.vfs.write('/d.txt', 'data')
    const lw = new LangchainWorkspace(ws)
    const [r] = await lw.downloadFiles(['/d.txt'])
    if (r === undefined) throw new Error('expected one response')
    expect(r.error).toBeNull()
    expect(r.content).not.toBeNull()
    if (r.content !== null) {
      expect(new TextDecoder().decode(r.content)).toBe('data')
    }
  })

  it('download returns error for missing files', async () => {
    const lw = new LangchainWorkspace(mkWs())
    const [r] = await lw.downloadFiles(['/missing.txt'])
    if (r === undefined) throw new Error('expected one response')
    expect(r.content).toBeNull()
    expect(r.error).toBe('file_not_found')
  })
})

describe('LangchainWorkspace.readRaw', () => {
  it('returns FileDataV2 with string content for text files', async () => {
    const ws = mkWs()
    await ws.vfs.write('/text.txt', 'hello')
    const lw = new LangchainWorkspace(ws)
    const r = await lw.readRaw('/text.txt')
    expect(r.error).toBeUndefined()
    const data = r.data
    if (data === undefined) throw new Error('expected data')
    if (!('mimeType' in data)) throw new Error('expected FileDataV2')
    expect(data.content).toBe('hello')
    expect(typeof data.mimeType).toBe('string')
    expect(data.modified_at).toBeDefined()
  })
})

async function guardedWs(): Promise<Workspace> {
  const ws = new Workspace(
    { '/': new RAMVFS(), '/vault': new RAMVFS() },
    {
      mode: MountMode.WRITE,
      profiles: { guarded: parseSessionProfile({ paths: { hide: ['/vault'] } }) },
    },
  )
  await ws.shell('echo key > /vault/key.txt')
  ws.createSession('agent', { profile: 'guarded' })
  return ws
}

describe('LangchainWorkspace sessionId', () => {
  it('acts as the session, under its profile', async () => {
    const ws = await guardedWs()
    const backend = new LangchainWorkspace(ws, { sessionId: 'agent' })
    const read = await backend.read('/vault/key.txt')
    const listed = await backend.ls('/')
    const ran = await backend.execute('cat /vault/key.txt')
    expect(read.error).toBeDefined()
    expect(listed.files?.map((f) => f.path)).not.toContain('/vault')
    expect(ran.exitCode).not.toBe(0)
    await ws.close()
  })
})
