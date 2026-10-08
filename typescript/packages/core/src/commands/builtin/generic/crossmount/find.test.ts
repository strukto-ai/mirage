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
import { command } from '../../../config.ts'
import { SPECS } from '../../../spec/index.ts'
import { IOResult } from '../../../../io/types.ts'
import { MountMode, PathSpec } from '../../../../types.ts'
import { eacces } from '../../../../errors/fs.ts'
import { RAMVFS } from '../../../../vfs/ram/ram.ts'
import { Workspace } from '../../../../workspace/workspace/workspace.ts'
import { getTestParser } from '../../../../workspace/fixtures/workspace_fixture.ts'
import { joints, predicates, shifted } from './find.ts'

const DEC = new TextDecoder()
const ENC = new TextEncoder()

function rowsFromItsOwnFind(rows = true) {
  const spec = SPECS.find
  if (spec === undefined) throw new Error('Missing spec: find')
  return command({
    name: 'find',
    vfs: 'ram',
    spec,
    fn: (_accessor, paths) => {
      const found = paths.map(
        (p) =>
          new PathSpec({
            virtual: `${p.virtual}/own`,
            directory: p.virtual,
            vfsPath: '',
            rawPath: `${p.rawPath}/own`,
          }),
      )
      return [
        ENC.encode(found.map((row) => `${row.rawPath}\n`).join('')),
        new IOResult({ matchedRuns: rows ? [found] : null }),
      ]
    },
  })
}

function refused() {
  const spec = SPECS.find
  if (spec === undefined) throw new Error('Missing spec: find')
  return command({
    name: 'find',
    vfs: 'ram',
    spec,
    fn: (_accessor, paths) => Promise.reject(eacces(paths[0] ?? '/')),
  })
}

class Unlisted extends RAMVFS {
  override readdir(): Promise<string[]> {
    return Promise.reject(eacces('/a'))
  }
}

async function workspace(rows = true, outer = new RAMVFS()): Promise<Workspace> {
  const inner = new RAMVFS()
  outer.loadState({
    type: 'ram',
    files: { '/d/f': ENC.encode('x'), '/n/shadowed': ENC.encode('y') },
    dirs: ['/', '/d', '/n'],
  })
  inner.loadState({ type: 'ram', files: { '/g': ENC.encode('z') } })
  const ws = new Workspace(
    { '/a': outer, '/a/n': inner },
    { mode: MountMode.WRITE, shellParser: await getTestParser() },
  )
  for (const cmd of rowsFromItsOwnFind(rows)) ws.registry.mountFor('/a/n/x').register(cmd)
  return ws
}

it('skips the words a predicate takes', () => {
  const words = ['-name', '-prune', '-exec', 'echo', '-empty', ';', '-print']
  expect(predicates(words)).toEqual([
    [0, '-name'],
    [2, '-exec'],
    [6, '-print'],
  ])
})

it('counts the depth limits from the start point', () => {
  const words = ['-maxdepth', '3', '-mindepth', '2', '-name', 'x']
  const bag = { maxdepth: '3', mindepth: '2', name: 'x' }
  expect(shifted(words, bag, 2, 3, 2)).toEqual([
    ['-maxdepth', '1', '-mindepth', '0', '-name', 'x'],
    { maxdepth: '1', mindepth: '0', name: 'x' },
  ])
  expect(shifted(words, bag, 4, 3, 2)).toBeNull()
  expect(shifted(words, bag, 1, 3, 2, true)).toBeNull()
  expect(shifted(['-type', 'd'], { type: 'd' }, 1, null, null, true)).toEqual([
    ['-maxdepth', '0', '-type', 'd'],
    { type: 'd', maxdepth: '0' },
  ])
})

it('names the directories between the operand and its mounts', () => {
  const root = PathSpec.fromStrPath('/')
  const starts = [root, ...['/usr/bin', '/a/b/c', '/a/b'].map((p) => PathSpec.fromStrPath(p))]
  expect(joints(root, starts).map((j) => j.virtual)).toEqual(['/a', '/usr'])
})

it('lets each mount answer for its own part', async () => {
  const ws = await workspace()
  try {
    expect(DEC.decode((await ws.shell('find /a')).stdout)).toBe('/a\n/a/d\n/a/d/f\n/a/n/own\n')
    expect(DEC.decode((await ws.shell('find / -maxdepth 1 -name usr')).stdout)).toBe('/usr\n')
  } finally {
    await ws.close()
  }
})

it.each(['find /a -name x -prune -o -print', 'find -L /a -type f'])(
  'keeps the one walk for an expression across mounts: %s',
  async (line) => {
    const ws = await workspace()
    try {
      const rows = DEC.decode((await ws.shell(line)).stdout)
      expect(rows).toContain('/a/n/g')
      expect(rows).not.toContain('own')
    } finally {
      await ws.close()
    }
  },
)

it('keeps the one walk for a find without rows', async () => {
  const ws = await workspace(false)
  try {
    expect(DEC.decode((await ws.shell('find /a -type f')).stdout)).toBe('/a/d/f\n/a/n/g\n')
  } finally {
    await ws.close()
  }
})

it.each([
  ['listed', new RAMVFS(), '/a/n/own\n'],
  ['unlisted', new Unlisted(), ''],
])('counts a mount below a failed part where the walk reaches: %s', async (_, outer, expected) => {
  const ws = await workspace(true, outer)
  for (const cmd of refused()) ws.registry.mountFor('/a/x').register(cmd)
  try {
    const result = await ws.shell('find /a')
    expect(DEC.decode(result.stdout)).toBe(expected)
    expect(result.exitCode).toBe(1)
  } finally {
    await ws.close()
  }
})
