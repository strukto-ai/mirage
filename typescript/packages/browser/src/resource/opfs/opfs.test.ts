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
import { installFakeNavigator, makeMockRoot, spec } from '../../test-utils.ts'
import { OPFSResource } from './opfs.ts'

let res: OPFSResource
let restoreNav: () => void

beforeEach(async () => {
  const root = makeMockRoot()
  restoreNav = installFakeNavigator(() => root)
  res = new OPFSResource()
  await res.open()
})

afterEach(() => {
  restoreNav()
})

describe('OPFSResource — identity', () => {
  it('has kind, prompt, defaults', () => {
    expect(res.kind).toBe(ResourceName.OPFS)
    expect(typeof res.prompt).toBe('string')
    expect(res.rootName).toBe('')
  })
  it('ops() returns the OPFS_OPS array', () => {
    expect(res.ops().length).toBeGreaterThan(0)
  })
  it('commands() returns OPFS_COMMANDS', () => {
    expect(res.commands().length).toBeGreaterThan(0)
  })
})

describe('OPFSResource — fs methods', () => {
  it('writeFile + readFile round-trip', async () => {
    await res.writeFile(spec('/x'), new TextEncoder().encode('hi'))
    expect(new TextDecoder().decode(await res.readFile(spec('/x')))).toBe('hi')
  })

  it('appendFile concatenates', async () => {
    await res.writeFile(spec('/a'), new TextEncoder().encode('1'))
    await res.appendFile(spec('/a'), new TextEncoder().encode('2'))
    expect(new TextDecoder().decode(await res.readFile(spec('/a')))).toBe('12')
  })

  it('readdir returns sorted virtual paths', async () => {
    await res.writeFile(spec('/b'), new Uint8Array())
    await res.writeFile(spec('/a'), new Uint8Array())
    expect(await res.readdir(spec('/'))).toEqual(['/a', '/b'])
  })

  it('stat distinguishes files and directories', async () => {
    await res.writeFile(spec('/file'), new TextEncoder().encode('x'))
    await res.mkdir(spec('/dir'))
    const f = await res.stat(spec('/file'))
    expect(f.size).toBe(1)
    expect(f.type).not.toBe(FileType.DIRECTORY)
    const d = await res.stat(spec('/dir'))
    expect(d.type).toBe(FileType.DIRECTORY)
  })

  it('exists / mkdir / rmdir / unlink', async () => {
    await res.mkdir(spec('/d'))
    expect(await res.exists(spec('/d'))).toBe(true)
    await res.rmdir(spec('/d'))
    expect(await res.exists(spec('/d'))).toBe(false)

    await res.writeFile(spec('/f'), new Uint8Array())
    await res.unlink(spec('/f'))
    expect(await res.exists(spec('/f'))).toBe(false)
  })

  it('rename + copy', async () => {
    await res.writeFile(spec('/a'), new TextEncoder().encode('A'))
    await res.rename(spec('/a'), spec('/b'))
    expect(new TextDecoder().decode(await res.readFile(spec('/b')))).toBe('A')
    await res.copy(spec('/b'), spec('/c'))
    expect(new TextDecoder().decode(await res.readFile(spec('/c')))).toBe('A')
  })

  it('truncate / streamPath / du', async () => {
    await res.mkdir(spec('/d'))
    await res.writeFile(spec('/d/a'), new Uint8Array([1, 2, 3]))
    await res.writeFile(spec('/d/b'), new Uint8Array([4, 5]))
    expect(await res.du(spec('/d'))).toBe(5)

    await res.truncate(spec('/d/a'), 1)
    const chunks: Uint8Array[] = []
    for await (const c of res.streamPath(spec('/d/a'))) chunks.push(c)
    expect(chunks[0]?.byteLength).toBe(1)
  })

  it('rmR removes recursively', async () => {
    await res.mkdir(spec('/d'))
    await res.writeFile(spec('/d/x'), new TextEncoder().encode('x'))
    await res.rmR(spec('/d'))
    expect(await res.exists(spec('/d'))).toBe(false)
  })

  it('find returns matches', async () => {
    await res.writeFile(spec('/a.json'), new Uint8Array())
    await res.writeFile(spec('/b.txt'), new Uint8Array())
    expect(await res.find(spec('/'), { name: '*.json' })).toEqual(['/a.json'])
  })
})

describe('OPFSResource — requireHandle', () => {
  it('throws after close()', async () => {
    await res.close()
    expect(() => res.requireHandle()).toThrow(/not open/)
  })
})

describe('OPFSResource — getState / loadState round-trip', () => {
  it('snapshots files and dirs', async () => {
    await res.writeFile(spec('/a'), new TextEncoder().encode('A'))
    await res.mkdir(spec('/d'))
    await res.writeFile(spec('/d/b'), new TextEncoder().encode('B'))

    const state = await res.getState()
    expect(Object.keys(state.files).sort()).toEqual(['a', 'd/b'])

    const root2 = makeMockRoot()
    restoreNav()
    restoreNav = installFakeNavigator(() => root2)
    const res2 = new OPFSResource()
    await res2.open()
    await res2.loadState(state)
    expect(new TextDecoder().decode(await res2.readFile(spec('/a')))).toBe('A')
    expect(new TextDecoder().decode(await res2.readFile(spec('/d/b')))).toBe('B')
  })
})
