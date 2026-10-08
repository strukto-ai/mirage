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
import { command, type CommandFn } from '../../../config.ts'
import { SPECS } from '../../../spec/index.ts'
import { duGeneric } from '../du.ts'
import { IOResult } from '../../../../io/types.ts'
import { FileStat, FileType, MountMode } from '../../../../types.ts'
import { eacces } from '../../../../errors/fs.ts'
import { RAMVFS } from '../../../../vfs/ram/ram.ts'
import { Workspace } from '../../../../workspace/workspace/workspace.ts'
import { getTestParser } from '../../../../workspace/fixtures/workspace_fixture.ts'

const DEC = new TextDecoder()
const ENC = new TextEncoder()

const measured: CommandFn = (_accessor, paths, _texts, opts) =>
  duGeneric(
    paths,
    opts,
    (targets) => Promise.resolve(targets),
    (p) => Promise.resolve(new FileStat({ name: p.virtual, type: FileType.DIRECTORY })),
    () => Promise.resolve(1000),
    () => Promise.resolve([[['/big', 1000]], 1000]),
  )

const unmeasured: CommandFn = (_accessor, paths) => [
  ENC.encode(`777\t${paths[0]?.rawPath ?? ''}\n`),
  new IOResult(),
]

const partlyMeasured: CommandFn = () => [
  new Uint8Array(),
  new IOResult({
    stderr: ENC.encode("du: cannot read directory '/a/d': Permission denied\n"),
    exitCode: 1,
    sizedRuns: [{ leaves: [['/a/d/f', 5]], directories: ['/a/d'] }],
  }),
]

class Unlisted extends RAMVFS {
  override readdir(): Promise<string[]> {
    return Promise.reject(eacces('/a'))
  }
}

async function workspace(fn: CommandFn, outer = new RAMVFS()): Promise<Workspace> {
  const inner = new RAMVFS()
  const other = new RAMVFS()
  outer.loadState({
    type: 'ram',
    files: { '/d/f': ENC.encode('12345'), '/n/shadowed': ENC.encode('y'.repeat(50)) },
    dirs: ['/', '/d', '/n'],
  })
  inner.loadState({ type: 'ram', files: { '/g': ENC.encode('123') } })
  other.loadState({ type: 'ram', files: { '/h': ENC.encode('22') } })
  const ws = new Workspace(
    { '/a': outer, '/a/n': inner, '/b': other },
    { mode: MountMode.WRITE, shellParser: await getTestParser() },
  )
  const spec = SPECS.du
  if (spec === undefined) throw new Error('Missing spec: du')
  for (const cmd of command({ name: 'du', vfs: 'ram', spec, fn }))
    ws.registry.mountFor('/a/n/x').register(cmd)
  return ws
}

it.each([
  ['du /a', '5\t/a/d\n1000\t/a/n\n1005\t/a\n'],
  ['du -s /a', '1005\t/a\n'],
  ['du -c -d 0 /a /b', '1005\t/a\n2\t/b\n1007\ttotal\n'],
  ['du -a /a/n /b', '1000\t/a/n/big\n1000\t/a/n\n2\t/b/h\n2\t/b\n'],
])('lets each mount measure its own part: %s', async (line, expected) => {
  const ws = await workspace(measured)
  try {
    const result = await ws.shell(line)
    expect(DEC.decode(result.stdout)).toBe(expected)
    expect(result.exitCode).toBe(0)
  } finally {
    await ws.close()
  }
})

it.each(['du -c /a', 'du -c /a/n /b'])(
  'keeps the one walk for a du without a measurement: %s',
  async (line) => {
    const ws = await workspace(unmeasured)
    try {
      const rows = DEC.decode((await ws.shell(line)).stdout)
      expect(rows).not.toContain('777')
      expect(rows).toContain('3\t/a/n\n')
    } finally {
      await ws.close()
    }
  },
)

it.each([
  ['listed', new RAMVFS(), '1005\t/a\n'],
  ['unlisted', new Unlisted(), '5\t/a\n'],
])('counts a mount below a failed part where the walk reaches: %s', async (_, outer, expected) => {
  const ws = await workspace(measured, outer)
  const spec = SPECS.du
  if (spec === undefined) throw new Error('Missing spec: du')
  for (const cmd of command({ name: 'du', vfs: 'ram', spec, fn: partlyMeasured }))
    ws.registry.mountFor('/a/x').register(cmd)
  try {
    const result = await ws.shell('du -s /a')
    expect(DEC.decode(result.stdout)).toBe(expected)
    expect(result.exitCode).toBe(1)
  } finally {
    await ws.close()
  }
})
