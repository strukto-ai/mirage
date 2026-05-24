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

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FileType, ResourceName } from '@struktoai/mirage-core'
import { spec, tmpRoot } from '../../test-utils.ts'
import { DiskResource } from './disk.ts'

let root: string
let cleanup: () => void
let res: DiskResource

beforeEach(async () => {
  ;({ root, cleanup } = tmpRoot('mirage-diskresource-'))
  res = new DiskResource({ root })
  await res.open()
})

afterEach(() => {
  cleanup()
})

describe('DiskResource — identity', () => {
  it('exposes kind, prompt, root', () => {
    expect(res.kind).toBe(ResourceName.DISK)
    expect(typeof res.prompt).toBe('string')
    expect(res.root).toBe(root)
  })

  it('ops() returns DISK_OPS', () => {
    expect(res.ops().length).toBeGreaterThan(0)
  })

  it('commands() returns RAM_COMMANDS', () => {
    expect(res.commands().length).toBeGreaterThan(0)
  })
})

describe('DiskResource — fs methods', () => {
  it('writeFile + readFile round-trip', async () => {
    await res.writeFile(spec('/x.txt'), new TextEncoder().encode('hello'))
    const data = await res.readFile(spec('/x.txt'))
    expect(new TextDecoder().decode(data)).toBe('hello')
  })

  it('writeFile creates parent dirs', async () => {
    await res.writeFile(spec('/a/b/c.txt'), new TextEncoder().encode('deep'))
    expect(new TextDecoder().decode(await res.readFile(spec('/a/b/c.txt')))).toBe('deep')
  })

  it('appendFile concatenates', async () => {
    await res.writeFile(spec('/a.txt'), new TextEncoder().encode('1'))
    await res.appendFile(spec('/a.txt'), new TextEncoder().encode('2'))
    expect(new TextDecoder().decode(await res.readFile(spec('/a.txt')))).toBe('12')
  })

  it('readdir returns full virtual paths sorted', async () => {
    await res.writeFile(spec('/b.txt'), new Uint8Array())
    await res.writeFile(spec('/a.txt'), new Uint8Array())
    expect(await res.readdir(spec('/'))).toEqual(['/a.txt', '/b.txt'])
  })

  it('stat distinguishes files and directories', async () => {
    await res.writeFile(spec('/file.txt'), new TextEncoder().encode('x'))
    await res.mkdir(spec('/dir'))
    const f = await res.stat(spec('/file.txt'))
    expect(f.size).toBe(1)
    expect(f.type).not.toBe(FileType.DIRECTORY)
    const d = await res.stat(spec('/dir'))
    expect(d.type).toBe(FileType.DIRECTORY)
  })

  it('exists() is truthy for created files and falsy for missing', async () => {
    await res.writeFile(spec('/p.txt'), new Uint8Array())
    expect(await res.exists(spec('/p.txt'))).toBe(true)
    expect(await res.exists(spec('/nope.txt'))).toBe(false)
  })

  it('mkdir + rmdir', async () => {
    await res.mkdir(spec('/d'))
    expect(await res.exists(spec('/d'))).toBe(true)
    await res.rmdir(spec('/d'))
    expect(await res.exists(spec('/d'))).toBe(false)
  })

  it('unlink removes a file', async () => {
    await res.writeFile(spec('/x'), new Uint8Array())
    await res.unlink(spec('/x'))
    expect(await res.exists(spec('/x'))).toBe(false)
  })

  it('rename moves a file', async () => {
    await res.writeFile(spec('/a'), new TextEncoder().encode('A'))
    await res.rename(spec('/a'), spec('/b'))
    expect(await res.exists(spec('/a'))).toBe(false)
    expect(new TextDecoder().decode(await res.readFile(spec('/b')))).toBe('A')
  })

  it('copy duplicates a file', async () => {
    await res.writeFile(spec('/src'), new TextEncoder().encode('CP'))
    await res.copy(spec('/src'), spec('/dst'))
    expect(new TextDecoder().decode(await res.readFile(spec('/dst')))).toBe('CP')
  })

  it('truncate shrinks a file', async () => {
    await res.writeFile(spec('/t'), new TextEncoder().encode('hello'))
    await res.truncate(spec('/t'), 2)
    expect(new TextDecoder().decode(await res.readFile(spec('/t')))).toBe('he')
  })

  it('rmR removes a directory recursively', async () => {
    await res.writeFile(spec('/d/x.txt'), new TextEncoder().encode('x'))
    await res.rmR(spec('/d'))
    expect(await res.exists(spec('/d'))).toBe(false)
  })

  it('du sums file sizes under a path', async () => {
    await res.writeFile(spec('/d/a'), new Uint8Array([1, 2, 3]))
    await res.writeFile(spec('/d/b'), new Uint8Array([4, 5]))
    expect(await res.du(spec('/d'))).toBe(5)
  })

  it('streamPath yields file bytes', async () => {
    await res.writeFile(spec('/big'), new TextEncoder().encode('chunk'))
    const chunks: Uint8Array[] = []
    for await (const c of res.streamPath(spec('/big'))) chunks.push(c)
    expect(new TextDecoder().decode(chunks[0])).toBe('chunk')
  })

  it('find returns matching paths', async () => {
    await res.writeFile(spec('/a.json'), new Uint8Array())
    await res.writeFile(spec('/b.txt'), new Uint8Array())
    const found = await res.find(spec('/'), { name: '*.json' })
    expect(found).toEqual(['/a.json'])
  })
})

describe('DiskResource — getState / loadState round-trip', () => {
  it('snapshots files', async () => {
    await res.writeFile(spec('/a.txt'), new TextEncoder().encode('A'))
    await res.mkdir(spec('/d'))
    await res.writeFile(spec('/d/b.txt'), new TextEncoder().encode('B'))

    const state = await res.getState()
    expect(Object.keys(state.files).sort()).toEqual(['a.txt', 'd/b.txt'])
    expect(state).not.toHaveProperty('needsOverride')
    expect(state).not.toHaveProperty('redactedFields')

    const { root: root2, cleanup: c2 } = tmpRoot('mirage-diskresource-load-')
    try {
      const res2 = new DiskResource({ root: root2 })
      await res2.open()
      await res2.loadState(state)
      expect(new TextDecoder().decode(await res2.readFile(spec('/a.txt')))).toBe('A')
      expect(new TextDecoder().decode(await res2.readFile(spec('/d/b.txt')))).toBe('B')
    } finally {
      c2()
    }
  })
})
