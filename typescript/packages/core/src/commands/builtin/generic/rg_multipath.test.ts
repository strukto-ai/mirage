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

import { mountKey } from '../../../utils/key_prefix.ts'
import { expect, it } from 'vitest'
import { FileStat, FileType, PathSpec } from '../../../types.ts'
import { rstripSlash } from '../../../utils/slash.ts'
import { materialize } from '../../../io/types.ts'
import type { Context } from '../../config.ts'
import { rgGeneric } from './rg.ts'

const ENC = new TextEncoder()

const FILES: Record<string, string> = {
  '/top1.txt': 'hello one\n',
  '/top2.txt': 'hello two\n',
}

function key(p: PathSpec): string {
  return rstripSlash(p.virtual) || '/'
}

function spec(path: string): PathSpec {
  return new PathSpec({
    virtual: path,
    directory: path,
    resolved: false,
    vfsPath: mountKey(path, ''),
  })
}

function ctx(flags: Record<string, string | boolean | number | string[]>): Context {
  return {
    stdin: null,
    flags,
    cwd: PathSpec.fromStrPath('/'),
  } as unknown as Context
}

const stat = (p: PathSpec): Promise<FileStat> => {
  const k = key(p)
  if (FILES[k] === undefined) return Promise.reject(new Error(`ENOENT: ${k}`))
  return Promise.resolve(new FileStat({ name: k.split('/').pop() ?? '', type: FileType.FILE }))
}

const readdir = (p: PathSpec): Promise<string[]> => Promise.reject(new Error(`ENOTDIR: ${key(p)}`))

it.each([
  [[], false],
  [['/top1.txt'], false],
  [['/top1.txt'], true],
  [['/top1.txt', '/top2.txt'], false],
] as const)('cancels streaming matches for paths=%j, -H=%s', async (paths, withFilename) => {
  const controller = new AbortController()
  const data = ENC.encode('hello '.repeat(100000) + '\n')
  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false
  let reads = 0
  async function* source(): AsyncIterable<Uint8Array> {
    try {
      reads += 1
      timer = setTimeout(() => {
        controller.abort()
      }, 0)
      yield await Promise.resolve(data)
      reads += 1
      throw new Error('read beyond the matching line')
    } finally {
      closed = true
    }
  }
  async function scan(): Promise<void> {
    const result = await rgGeneric(
      paths.map(spec),
      ['hello'],
      {
        ...ctx({ only_matching: true, byte_offset: true, with_filename: withFilename }),
        stdin: paths.length === 0 ? source() : null,
        signal: controller.signal,
      },
      stat,
      readdir,
      source,
    )
    if (result === null) throw new Error('rg returned no result')
    await materialize(result[0])
  }
  try {
    await expect(scan()).rejects.toMatchObject({ name: 'AbortError' })
    expect(reads).toBe(1)
    expect(closed).toBe(true)
  } finally {
    clearTimeout(timer)
  }
})
