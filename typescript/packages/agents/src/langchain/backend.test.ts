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
import { OpsRegistry, RAMResource, MountMode, Workspace } from '@struktoai/mirage-node'
import { LangchainWorkspace } from './backend.ts'

function mkWs(): Workspace {
  const ram = new RAMResource()
  const ops = new OpsRegistry()
  for (const op of ram.ops()) ops.register(op)
  return new Workspace({ '/': ram }, { mode: MountMode.WRITE, ops })
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
    expect(await ws.fs.readFileText('/hello.txt')).toBe('hi')
  })

  it('rejects existing path', async () => {
    const ws = mkWs()
    await ws.fs.writeFile('/exists.txt', 'x')
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
    expect(await ws.fs.readFileText('/sub/nested.txt')).toBe('x')
  })
})

describe('LangchainWorkspace.read', () => {
  it('returns content from existing file', async () => {
    const ws = mkWs()
    await ws.fs.writeFile('/notes.txt', 'one\ntwo\nthree\n')
    const lw = new LangchainWorkspace(ws)
    const r = await lw.read('/notes.txt')
    expect(r.error).toBeUndefined()
    expect(r.content).toBe('one\ntwo\nthree\n')
    expect(r.mimeType).toBe('text/plain')
  })

  it('honors offset and limit', async () => {
    const ws = mkWs()
    await ws.fs.writeFile('/n.txt', 'a\nb\nc\nd\n')
    const lw = new LangchainWorkspace(ws)
    const r = await lw.read('/n.txt', 1, 2)
    expect(r.content).toBe('b\nc')
  })

  it('returns error for missing file', async () => {
    const lw = new LangchainWorkspace(mkWs())
    const r = await lw.read('/nope.txt')
    expect(r.error).toBeDefined()
    expect(r.content).toBeUndefined()
  })

  it('returns Uint8Array for application/pdf', async () => {
    const ws = mkWs()
    await ws.fs.writeFile('/x.pdf', new Uint8Array([0x25, 0x50, 0x44, 0x46]))
    const r = await new LangchainWorkspace(ws).read('/x.pdf')
    expect(r.error).toBeUndefined()
    expect(r.content).toBeInstanceOf(Uint8Array)
    expect(r.mimeType).toBe('application/pdf')
  })

  it('returns Uint8Array for supported image mimes', async () => {
    const ws = mkWs()
    await ws.fs.writeFile('/x.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
    const r = await new LangchainWorkspace(ws).read('/x.png')
    expect(r.content).toBeInstanceOf(Uint8Array)
    expect(r.mimeType).toBe('image/png')
  })

  it('refuses unsupported binary mimes with shell-redirect error', async () => {
    const ws = mkWs()
    await ws.fs.writeFile('/x.bin', new Uint8Array([0x00, 0x01, 0x02, 0x03]))
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
      await ws.fs.writeFile(path, new Uint8Array([0x00, 0x01, 0x02, 0x03]))
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
    await ws.fs.writeFile('/f.txt', 'foo bar baz')
    const lw = new LangchainWorkspace(ws)
    const r = await lw.edit('/f.txt', 'bar', 'BAR')
    expect(r.error).toBeUndefined()
    expect(r.occurrences).toBe(1)
    expect(await ws.fs.readFileText('/f.txt')).toBe('foo BAR baz')
  })

  it('rejects multiple occurrences without replaceAll', async () => {
    const ws = mkWs()
    await ws.fs.writeFile('/f.txt', 'aa aa')
    const lw = new LangchainWorkspace(ws)
    const r = await lw.edit('/f.txt', 'aa', 'X')
    expect(r.error).toContain('appears 2 times')
  })

  it('replaces all when replaceAll=true', async () => {
    const ws = mkWs()
    await ws.fs.writeFile('/f.txt', 'aa aa')
    const lw = new LangchainWorkspace(ws)
    const r = await lw.edit('/f.txt', 'aa', 'X', true)
    expect(r.occurrences).toBe(2)
    expect(await ws.fs.readFileText('/f.txt')).toBe('X X')
  })

  it('returns error for missing file', async () => {
    const lw = new LangchainWorkspace(mkWs())
    const r = await lw.edit('/nope.txt', 'x', 'y')
    expect(r.error).toContain('not found')
  })

  it('returns error when string not in file', async () => {
    const ws = mkWs()
    await ws.fs.writeFile('/f.txt', 'abc')
    const lw = new LangchainWorkspace(ws)
    const r = await lw.edit('/f.txt', 'zzz', 'y')
    expect(r.error).toContain('not found')
  })
})

describe('LangchainWorkspace.ls', () => {
  it('lists files and directories with is_dir flag', async () => {
    const ws = mkWs()
    await ws.fs.writeFile('/a.txt', 'a')
    await ws.fs.mkdir('/d')
    await ws.fs.writeFile('/d/b.txt', 'b')
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
    await ws.fs.mkdir("/it's a dir")
    await ws.fs.writeFile("/it's a dir/file.txt", 'x')
    const lw = new LangchainWorkspace(ws)
    const r = await lw.ls("/it's a dir")
    const paths = (r.files ?? []).map((i) => i.path)
    expect(paths).toContain("/it's a dir/file.txt")
  })
})

describe('LangchainWorkspace.glob', () => {
  it('finds files matching a pattern', async () => {
    const ws = mkWs()
    await ws.fs.writeFile('/a.csv', 'a')
    await ws.fs.writeFile('/b.csv', 'b')
    await ws.fs.writeFile('/c.txt', 'c')
    const lw = new LangchainWorkspace(ws)
    const r = await lw.glob('*.csv', '/')
    const paths = (r.files ?? []).map((i) => i.path).sort()
    expect(paths).toContain('/a.csv')
    expect(paths).toContain('/b.csv')
    expect(paths).not.toContain('/c.txt')
  })
})

describe('LangchainWorkspace.grep', () => {
  it('returns matches with line numbers', async () => {
    const ws = mkWs()
    await ws.fs.writeFile('/log.txt', 'one\nerror here\ntwo\nerror again\n')
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
    await ws.fs.writeFile('/log.txt', 'no match\n')
    const lw = new LangchainWorkspace(ws)
    const r = await lw.grep('zzz', '/log.txt')
    expect(r.matches).toEqual([])
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
    expect(await ws.fs.readFileText('/up1.txt')).toBe('one')
    expect(await ws.fs.readFileText('/up2.txt')).toBe('two')
  })

  it('download returns content for existing files', async () => {
    const ws = mkWs()
    await ws.fs.writeFile('/d.txt', 'data')
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
    await ws.fs.writeFile('/text.txt', 'hello')
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
