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
import { MirageEditor } from './editor.ts'

function mkWs(): Workspace {
  const ram = new RAMVFS()
  const ops = new OpsRegistry()
  for (const op of ram.ops()) ops.register(op)
  return new Workspace({ '/': ram }, { mode: MountMode.WRITE, ops })
}

describe('MirageEditor', () => {
  it('createFile writes content from a create-mode diff', async () => {
    const ws = mkWs()
    const editor = new MirageEditor(ws)

    const result = await editor.createFile({
      type: 'create_file',
      path: '/hello.txt',
      diff: '+hello world\n+\n',
    })

    expect(result).toEqual({ status: 'completed' })
    expect(await ws.vfs.readFileText('/hello.txt')).toBe('hello world\n')
  })

  it('createFile auto-mkdirs missing parent directories', async () => {
    const ws = mkWs()
    const editor = new MirageEditor(ws)

    const result = await editor.createFile({
      type: 'create_file',
      path: '/data/sub/file.txt',
      diff: '+content\n+\n',
    })

    expect(result).toEqual({ status: 'completed' })
    expect(await ws.vfs.readFileText('/data/sub/file.txt')).toBe('content\n')
  })

  it('createFile handles a root-level relative path without recursing on "."', async () => {
    const ws = mkWs()
    const editor = new MirageEditor(ws)

    const result = await editor.createFile({
      type: 'create_file',
      path: 'bare.txt',
      diff: '+bare\n',
    })

    expect(result).toEqual({ status: 'completed' })
    expect(await ws.vfs.readFileText('bare.txt')).toBe('bare')
  })

  it('createFile is idempotent on existing parent', async () => {
    const ws = mkWs()
    await ws.vfs.mkdir('/data')
    const editor = new MirageEditor(ws)

    const result = await editor.createFile({
      type: 'create_file',
      path: '/data/file.txt',
      diff: '+hi\n',
    })

    expect(result).toEqual({ status: 'completed' })
  })

  it('updateFile applies a diff to existing content', async () => {
    const ws = mkWs()
    await ws.vfs.writeFile('/notes.txt', 'one\ntwo\nthree\n')
    const editor = new MirageEditor(ws)

    const diff = '@@\n one\n-two\n+TWO\n three\n'
    const result = await editor.updateFile({
      type: 'update_file',
      path: '/notes.txt',
      diff,
    })

    expect(result).toEqual({ status: 'completed' })
    expect(await ws.vfs.readFileText('/notes.txt')).toBe('one\nTWO\nthree\n')
  })

  it('updateFile returns failed for missing path', async () => {
    const ws = mkWs()
    const editor = new MirageEditor(ws)

    const result = await editor.updateFile({
      type: 'update_file',
      path: '/nope.txt',
      diff: '@@\n+ x\n',
    })

    expect(result).toEqual({
      status: 'failed',
      output: 'File not found: /nope.txt',
    })
  })

  it('deleteFile removes the file', async () => {
    const ws = mkWs()
    await ws.vfs.writeFile('/gone.txt', 'bye')
    const editor = new MirageEditor(ws)

    const result = await editor.deleteFile({
      type: 'delete_file',
      path: '/gone.txt',
    })

    expect(result).toEqual({ status: 'completed' })
    expect(await ws.vfs.exists('/gone.txt')).toBe(false)
  })

  it('deleteFile returns failed for missing path', async () => {
    const ws = mkWs()
    const editor = new MirageEditor(ws)

    const result = await editor.deleteFile({
      type: 'delete_file',
      path: '/missing.txt',
    })

    expect(result).toEqual({
      status: 'failed',
      output: 'File not found: /missing.txt',
    })
  })
})
