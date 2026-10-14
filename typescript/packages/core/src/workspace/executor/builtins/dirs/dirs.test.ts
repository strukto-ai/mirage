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
import { PathSpec } from '../../../../types.ts'
import { CycleError, resolveSymlinks } from '../../../../utils/path.ts'
import { joinPath, resolveTarget, splitModeOptions, typedPath } from './dirs.ts'

// A follow over a fixed link table, as the session's link view resolves.
function through(links: ReadonlyMap<string, string>): (path: string) => string {
  return (path) => resolveSymlinks(path, links)
}

describe('splitModeOptions', () => {
  it('reads clusters and applies last-wins', () => {
    const { operands, bad, physical } = splitModeOptions(['-LP', 'x'])
    expect(operands).toEqual(['x'])
    expect(bad).toBeNull()
    expect(physical).toBe(true)
    expect(splitModeOptions(['-P', '-L']).physical).toBe(false)
  })

  it('reports the first unknown letter', () => {
    const { operands, bad } = splitModeOptions(['-Lz', 'x'], 'LP')
    expect(bad).toBe('z')
    expect(operands).toEqual([])
  })

  it('treats a bare dash as an operand and -- as the end of options', () => {
    expect(splitModeOptions(['-'])).toEqual({ operands: ['-'], bad: null, physical: false })
    expect(splitModeOptions(['--', '-P'])).toEqual({ operands: ['-P'], bad: null, physical: false })
  })

  it('reads a PathSpec operand', () => {
    const spec = PathSpec.fromStrPath('/data/x')
    const { operands, bad, physical } = splitModeOptions([spec], undefined, true)
    expect(operands).toEqual([spec])
    expect(bad).toBeNull()
    expect(physical).toBe(true)
  })
})

describe('the cd path helpers', () => {
  it('joinPath keeps .. intact', () => {
    expect(joinPath('x/..', '/data')).toBe('/data/x/..')
    expect(joinPath('/abs', '/data')).toBe('/abs')
  })

  it('typedPath keeps the spelling', () => {
    const spec = PathSpec.fromStrPath('/data/x')
    expect(typedPath(spec)).toBe(spec.rawPath || spec.virtual)
    expect(typedPath('y')).toBe('y')
  })

  it('resolveTarget follows links before or after .. per mode', () => {
    const links = through(new Map([['/data/lk', '/data/deep/real']]))
    expect(resolveTarget('/data/lk/..', links, false)).toBe('/data')
    expect(resolveTarget('/data/lk/..', links, true)).toBe('/data/deep')
  })

  it('resolveTarget refuses a loop', () => {
    const links = through(
      new Map([
        ['/a', '/b'],
        ['/b', '/a'],
      ]),
    )
    expect(() => resolveTarget('/a', links, true)).toThrow(CycleError)
  })
})
