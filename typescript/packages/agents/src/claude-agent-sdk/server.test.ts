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
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import * as shared from '@struktoai/mirage-core/workspace/tools/tool_descriptions'
import { MirageServer } from './server.ts'

function mkWs(): Workspace {
  const ram = new RAMVFS()
  const ops = new OpsRegistry()
  for (const op of ram.ops()) ops.register(op)
  return new Workspace({ '/': ram }, { mode: MountMode.WRITE, ops })
}

function firstText(r: { content: { text: string }[] }): string {
  return r.content[0]?.text ?? ''
}

describe('shell', () => {
  it('echoes', async () => {
    const result = await mkWs().tools.shell('echo hello')
    expect(firstText(result)).toContain('hello')
    expect(result.isError).not.toBe(true)
  })

  it('runs a pipe', async () => {
    const ws = mkWs()
    await ws.vfs.write('/pipe.txt', 'aaa\nbbb\naaa\n')
    const result = await ws.tools.shell('cat /pipe.txt | sort | uniq | wc -l')
    expect(firstText(result)).toContain('2')
  })
})

describe('read', () => {
  it('reads a file', async () => {
    const ws = mkWs()
    await ws.vfs.write('/hello.txt', 'line1\nline2\nline3\n')
    const result = await ws.tools.read('/hello.txt')
    expect(firstText(result)).toContain('line1')
    expect(firstText(result)).toContain('line2')
    expect(result.isError).not.toBe(true)
  })

  it('honors offset and limit', async () => {
    const ws = mkWs()
    await ws.vfs.write('/multi.txt', 'a\nb\nc\nd\ne\n')
    const result = await ws.tools.read('/multi.txt', 1, 2)
    const text = firstText(result)
    expect(text).toContain('b')
    expect(text).toContain('c')
    expect(text).not.toContain('a')
    expect(text).not.toContain('d')
  })

  it('errors on missing file', async () => {
    const result = await mkWs().tools.read('/nonexistent.txt')
    expect(result.isError).toBe(true)
    expect(firstText(result)).toContain('not found')
  })
})

describe('write', () => {
  it('writes a new file', async () => {
    const ws = mkWs()
    const result = await ws.tools.write('/new.txt', 'hello world')
    expect(result.isError).not.toBe(true)
    expect(await ws.vfs.cat('/new.txt')).toBe('hello world')
  })

  it('refuses an unread file', async () => {
    const ws = mkWs()
    await ws.vfs.write('/exists.txt', 'first')
    const result = await ws.tools.write('/exists.txt', 'second')
    expect(result.isError).toBe(true)
    expect(firstText(result)).toContain('read all of it before overwriting it')
  })

  it('creates parent directories', async () => {
    const ws = mkWs()
    const result = await ws.tools.write('/nested/deep/file.txt', 'hi')
    expect(result.isError).not.toBe(true)
    expect(await ws.vfs.cat('/nested/deep/file.txt')).toBe('hi')
  })
})

describe('edit', () => {
  it('replaces a string', async () => {
    const ws = mkWs()
    await ws.vfs.write('/edit.txt', 'foo bar baz')
    const result = await ws.tools.edit('/edit.txt', 'bar', 'qux')
    expect(result.isError).not.toBe(true)
    expect(await ws.vfs.cat('/edit.txt')).toBe('foo qux baz')
  })

  it('errors on missing file', async () => {
    const result = await mkWs().tools.edit('/missing.txt', 'x', 'y')
    expect(result.isError).toBe(true)
    expect(firstText(result)).toContain('not found')
  })

  it('errors when the string is not found', async () => {
    const ws = mkWs()
    await ws.vfs.write('/nostr.txt', 'hello world')
    const result = await ws.tools.edit('/nostr.txt', 'xyz', 'abc')
    expect(result.isError).toBe(true)
    expect(firstText(result)).toContain('not found')
  })

  it('errors on multiple occurrences without replace_all', async () => {
    const ws = mkWs()
    await ws.vfs.write('/multi.txt', 'aa bb aa')
    const result = await ws.tools.edit('/multi.txt', 'aa', 'cc')
    expect(result.isError).toBe(true)
    expect(firstText(result)).toContain('replace_all')
  })

  it('replaces all occurrences', async () => {
    const ws = mkWs()
    await ws.vfs.write('/all.txt', 'aa bb aa')
    const result = await ws.tools.edit('/all.txt', 'aa', 'cc', true)
    expect(result.isError).not.toBe(true)
    expect(await ws.vfs.cat('/all.txt')).toBe('cc bb cc')
  })
})

describe('ls', () => {
  it('lists a directory', async () => {
    const ws = mkWs()
    await ws.tools.write('/dir/a.txt', 'a')
    await ws.tools.write('/dir/b.txt', 'b')
    const result = await ws.tools.ls('/dir')
    expect(firstText(result)).toContain('a.txt')
    expect(firstText(result)).toContain('b.txt')
  })
})

describe('grep', () => {
  it('searches recursively', async () => {
    const ws = mkWs()
    await ws.vfs.write('/search.txt', 'hello world\ngoodbye world\nhello again\n')
    const result = await ws.tools.grep('hello', '/')
    expect(firstText(result)).toContain('hello')
  })
})

describe('MirageServer', () => {
  it('advertises the shared input schemas', async () => {
    const ws = mkWs()
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const { instance } = MirageServer(ws)
    await instance.connect(serverTransport)
    const client = new Client({ name: 'mirage-test', version: '1.0.0' })
    await client.connect(clientTransport)
    const listed = new Map((await client.listTools()).tools.map((t) => [t.name, t]))
    const expected = {
      shell: shared.SHELL_INPUT,
      read: shared.READ_INPUT,
      write: shared.WRITE_INPUT,
      edit: shared.EDIT_INPUT,
      ls: shared.LS_INPUT,
      grep: shared.GREP_INPUT,
      glob: shared.GLOB_INPUT,
    }
    expect([...listed.keys()].sort()).toEqual(Object.keys(expected).sort())
    for (const [name, schema] of Object.entries(expected)) {
      const advertised = listed.get(name)?.inputSchema
      expect([...(advertised?.required ?? [])].sort()).toEqual([...schema.required].sort())
      // The SDK renders zod's int() and min() as a bare number; the shape
      // still enforces them when it parses a call.
      const want = Object.fromEntries(
        Object.entries(
          schema.properties as Record<string, { type: string; description: string }>,
        ).map(([key, prop]) => [
          key,
          { type: prop.type === 'integer' ? 'number' : prop.type, description: prop.description },
        ]),
      )
      expect(advertised?.properties).toMatchObject(want)
    }
    expect(
      ['read', 'ls', 'grep', 'glob'].map((n) => listed.get(n)?.annotations?.readOnlyHint),
    ).toEqual([true, true, true, true])
    await client.close()
    await ws.close()
  })
})
