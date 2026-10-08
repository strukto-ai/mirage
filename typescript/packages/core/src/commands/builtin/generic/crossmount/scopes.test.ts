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

import { expect, it } from 'vitest'
import { IOResult } from '../../../../io/types.ts'
import type { MountView, NamespaceView } from '../../../../view/types.ts'
import type { DispatchFn } from '../../../../runtime/types.ts'
import { FileStat, FileType, PathSpec } from '../../../../types.ts'
import { eacces } from '../../../../errors/fs.ts'
import { mountStarts, ownedScopes, reached } from './scopes.ts'
import type { OwnedScope } from './types.ts'

const DIRS: Record<string, string[]> = {
  '/a': ['/a/d', '/a/f', '/a/m'],
  '/a/d': ['/a/d/g'],
  '/a/m': [],
}
const ROOTS = ['/a', '/a/m']

function ns(): NamespaceView {
  const below = (path: string): string[] =>
    ROOTS.filter((r) => r.startsWith(path.replace(/\/$/, '') + '/'))
  const mounts: MountView = {
    descendants: below,
    visibleDescendants: below,
    isRoot: (p) => ROOTS.includes(p),
    rootOf: (p) => (p.startsWith('/a/m') ? '/a/m/' : '/a/'),
  }
  return { mounts }
}

function dispatcher(refused?: string): [DispatchFn, string[]] {
  const listed: string[] = []
  const dispatch: DispatchFn = (op, path) => {
    if (path.virtual === refused) return Promise.reject(eacces(path))
    if (op === 'readdir') {
      listed.push(path.virtual)
      return Promise.resolve([DIRS[path.virtual] ?? [], new IOResult()])
    }
    const type = path.virtual in DIRS ? FileType.DIRECTORY : FileType.FILE
    return Promise.resolve([new FileStat({ name: path.virtual, type }), new IOResult()])
  }
  return [dispatch, listed]
}

async function collect(
  path: string,
  dispatch: DispatchFn,
  admit: (p: PathSpec, s: FileStat) => boolean = () => true,
): Promise<OwnedScope[]> {
  const out: OwnedScope[] = []
  for await (const scope of ownedScopes(PathSpec.fromStrPath(path), dispatch, ns(), admit))
    out.push(scope)
  return out
}

it('expands only a directory holding a mount', async () => {
  const [dispatch, listed] = dispatcher()
  const scopes = await collect('/a', dispatch)
  expect(scopes.map((s) => [s.path.virtual, s.walked])).toEqual([
    ['/a/d', true],
    ['/a/f', true],
    ['/a/m', true],
  ])
  expect(listed).toEqual(['/a'])
  const [single] = dispatcher()
  expect((await collect('/a/d', single)).map((s) => s.path.virtual)).toEqual(['/a/d'])
})

it('drops walked entries admit refuses and keeps a refusal as its own scope', async () => {
  const [dispatch] = dispatcher()
  const dirs = await collect('/a', dispatch, (_p, s) => s.type === FileType.DIRECTORY)
  expect(dirs.map((s) => s.path.virtual)).toEqual(['/a/d', '/a/m'])
  const [refusing] = dispatcher('/a/f')
  const scopes = await collect('/a', refusing)
  expect(
    scopes.map((s) => [s.path.virtual, (s.error as { code?: string } | undefined)?.code ?? null]),
  ).toEqual([
    ['/a/d', null],
    ['/a/f', 'EACCES'],
    ['/a/m', null],
  ])
})

it('starts at the operand, then at each mount below it', () => {
  const operand = new PathSpec({ virtual: '/a', directory: '/a', vfsPath: 'a', rawPath: './a' })
  const starts = mountStarts(operand, ns())
  expect(starts[0]).toBe(operand)
  expect(starts.slice(1).map((s) => [s.virtual, s.rawPath])).toEqual([['/a/m', './a/m']])
  const refused = new PathSpec({
    virtual: '/a',
    directory: '/a',
    vfsPath: 'a',
    walkError: 'ENOENT',
  })
  expect(mountStarts(refused, ns())).toEqual([refused])
  expect(mountStarts(operand, undefined)).toEqual([operand])
})

it('counts a start below a failed part only where it lists', async () => {
  const paths = [PathSpec.fromStrPath('/a'), PathSpec.fromStrPath('/a/d')]
  const starts = [
    [0, paths[0]],
    [0, PathSpec.fromStrPath('/a/m')],
    [0, PathSpec.fromStrPath('/a/d/g')],
    [1, paths[1]],
  ] as [number, PathSpec][]
  const [dispatch, listed] = dispatcher('/a/d')
  expect(await reached(paths, starts, [false, false, false, false], dispatch)).toEqual([
    true,
    true,
    true,
    true,
  ])
  expect(listed).toEqual([])
  expect(await reached(paths, starts, [true, false, false, true], dispatch)).toEqual([
    true,
    true,
    false,
    true,
  ])
  expect(listed).toEqual(['/a'])
})
