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
import type { FileStat } from '../../../types.ts'
import { PathSpec } from '../../../types.ts'
import { enoent } from '../../../utils/errors.ts'
import { resolveScript, splitReadable } from './operands.ts'

function spec(virtual: string): PathSpec {
  return PathSpec.fromStrPath(virtual)
}

function statOf(missing: Set<string>): (p: PathSpec) => Promise<FileStat> {
  return (p: PathSpec) => {
    if (missing.has(p.virtual)) return Promise.reject(enoent(p))
    return Promise.resolve({ size: 0 } as FileStat)
  }
}

describe('splitReadable', () => {
  it('keeps order and reports each missing operand', async () => {
    const paths = [spec('/m1.txt'), spec('/f.txt'), spec('/m2.txt')]
    const [readable, err] = await splitReadable(
      paths,
      statOf(new Set(['/m1.txt', '/m2.txt'])),
      'cat',
    )
    expect(readable.map((p) => p.virtual)).toEqual(['/f.txt'])
    expect(err).toBe(
      'cat: /m1.txt: No such file or directory\n' + 'cat: /m2.txt: No such file or directory\n',
    )
  })

  it('returns no stderr when all operands resolve', async () => {
    const [readable, err] = await splitReadable([spec('/f.txt')], statOf(new Set()), 'head')
    expect(readable.map((p) => p.virtual)).toEqual(['/f.txt'])
    expect(err).toBe('')
  })

  it('propagates non-filesystem errors', async () => {
    const stat = () => Promise.reject(new Error('backend broke'))
    await expect(splitReadable([spec('/f.txt')], stat, 'cat')).rejects.toThrow('backend broke')
  })
})

describe('resolveScript', () => {
  it('normalizes an absolute path', () => {
    const s = resolveScript('/data/../data/run.py', '/cwd')
    expect(s.virtual).toBe('/data/run.py')
    expect(s.resourcePath).toBe('data/run.py')
    expect(s.directory).toBe('/data/')
    expect(s.resolved).toBe(true)
  })

  it('joins a relative path against cwd', () => {
    const s = resolveScript('sub/run.mjs', '/data')
    expect(s.virtual).toBe('/data/sub/run.mjs')
    expect(s.directory).toBe('/data/sub/')
  })
})
