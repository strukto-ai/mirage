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

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ClientModule from './client.ts'
import { FakeStore, makeAccessor, mockedClient, spec } from '../../../tests/core/gridfs/_test_util.ts'

let store = new FakeStore()

vi.mock('./client.ts', async () => {
  const actual = await vi.importActual<typeof ClientModule>('./client.ts')
  return mockedClient(actual, () => store)
})

import { runWithRevisions } from '@struktoai/mirage-core/observe/context'
import { exists } from './exists.ts'
import { read } from './read.ts'
import { readdir, tree } from './readdir.ts'
import { stat } from './stat.ts'
import { readStream } from './stream.ts'
import { unlink } from './unlink.ts'
import { write } from './write.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()
const A_TXT = spec('a.txt')
const ROOT = spec('')

async function seedAndRm(): Promise<string[]> {
  const accessor = makeAccessor(store)
  await write(accessor, A_TXT, ENC.encode('v1'))
  await write(accessor, A_TXT, ENC.encode('v2'))
  const ids = store.ids('a.txt')
  await unlink(accessor, A_TXT)
  return ids
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (err) {
    return (err as { code?: string }).code ?? 'no-code'
  }
  return 'no-throw'
}

// Twins of tests/core/gridfs/test_unlink.py.
describe('gridfs unlink', () => {
  beforeEach(() => {
    store = new FakeStore()
  })

  it('moves every revision to the trash', async () => {
    // rm retags the revisions the way mv does, so each keeps its _id and
    // its chunks: a snapshot pinned to an older revision still names a
    // document.
    const ids = await seedAndRm()
    expect(store.names()).toEqual(['/trash/a.txt', '/trash/a.txt'])
    expect(store.ids('/trash/a.txt')).toEqual(ids)
    expect([...store.chunks.keys()].sort()).toEqual([...ids].sort())
  })

  it('keeps a pinned read working after rm', async () => {
    const [first] = await seedAndRm()
    const pins = new Map([[A_TXT.virtual, first ?? ""]])
    const bytes = await runWithRevisions(pins, () => read(makeAccessor(store), A_TXT))
    expect(DEC.decode(bytes)).toBe('v1')
    const chunks = await runWithRevisions(pins, async () => {
      const out: Uint8Array[] = []
      for await (const chunk of readStream(makeAccessor(store), A_TXT)) out.push(chunk)
      return out
    })
    expect(DEC.decode(Buffer.concat(chunks))).toBe('v1')
  })

  it('reads the name as gone after rm', async () => {
    await seedAndRm()
    const accessor = makeAccessor(store)
    await expect(readdir(accessor, ROOT)).resolves.toEqual([])
    expect(await tree(accessor, ROOT)).toBeFalsy()
    await expect(exists(accessor, A_TXT)).resolves.toBe(false)
    await expect(codeOf(stat(accessor, A_TXT))).resolves.toBe('ENOENT')
    await expect(codeOf(read(accessor, A_TXT))).resolves.toBe('ENOENT')
    await expect(codeOf(unlink(accessor, A_TXT))).resolves.toBe('ENOENT')
  })

  it('starts a fresh revision on a write after rm', async () => {
    const old = await seedAndRm()
    const accessor = makeAccessor(store)
    await write(accessor, A_TXT, ENC.encode('v3'))
    expect(DEC.decode(await read(accessor, A_TXT))).toBe('v3')
    expect((await readdir(accessor, ROOT)).map((row) => row.name)).toEqual(['a.txt'])
    const [fresh] = store.ids('a.txt')
    expect(old).not.toContain(fresh)
    expect((await stat(accessor, A_TXT)).fingerprint).toBe(fresh)
    expect(store.ids('/trash/a.txt')).toEqual(old)
  })
})
