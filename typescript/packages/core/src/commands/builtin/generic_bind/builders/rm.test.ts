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

import { describe, expect, it, vi } from 'vitest'
import type { Accessor } from '../../../../accessor/base.ts'
import { runWithMountGate } from '../../../../context/session_context.ts'
import { materialize } from '../../../../io/types.ts'
import type { Files } from '../../../../workspace/files.ts'
import { FileStat, FileType, MountMode, PathSpec } from '../../../../types.ts'
import { eacces, enoent, walkDeclined, walkRefusal } from '../../../../errors/fs.ts'
import { answeringFiles } from '../../../../test-utils.ts'
import { generic } from '../factory.ts'
import { BUILDER } from './rm.ts'

const DEC = new TextDecoder()
const TREE: Record<string, string[]> = {
  '/m': ['/m/a.txt', '/m/d', '/m/locked'],
  '/m/d': ['/m/d/x.txt'],
  '/m/locked': ['/m/locked/f.txt'],
}
const FILES = new Set(['/m/a.txt', '/m/d/x.txt', '/m/locked/f.txt'])

// A mount that removes nothing unless `removed` is given, whose stat is the
// dispatcher's: it answers what the session may see. Its row names the
// removals it answers, as Python's Answers does.
function files(removed?: string[]): Files {
  const remove = (p: PathSpec): null => {
    removed?.push(p.virtual)
    return null
  }
  return answeringFiles(
    {
      readdir: (p) => TREE[p.virtual] ?? [],
      stat: (p) => {
        if (p.virtual.startsWith('/m/locked/')) throw eacces(p.virtual)
        if (TREE[p.virtual] !== undefined)
          return new FileStat({ name: p.virtual, type: FileType.DIRECTORY })
        if (FILES.has(p.virtual)) return new FileStat({ name: p.virtual, type: FileType.FILE })
        throw enoent(p.virtual)
      },
      ...(removed === undefined ? {} : { unlink: remove, rm_r: remove }),
    },
    {},
    [
      {
        prefix: '/',
        kind: 'fake',
        calls: new Set(removed === undefined ? [] : ['unlink', 'rm_r']),
      },
    ],
  )
}

async function rm(
  vfs: Files,
  paths: string[],
  flags: Record<string, boolean> = {},
): Promise<[number, string, string]> {
  const result = await runWithMountGate('/', MountMode.WRITE, async () =>
    BUILDER.fn(
      {} as Accessor,
      paths.map((p) => PathSpec.fromStrPath(p)),
      [],
      { stdin: null, flags, cwd: PathSpec.fromStrPath('/'), vfs },
    ),
  )
  if (result === null) throw new Error('rm returned no result')
  const [out, res] = result
  return [
    res.exitCode,
    DEC.decode(await materialize(out)),
    DEC.decode(await materialize(res.stderr)),
  ]
}

describe('rm builder', () => {
  it('stats its operand through the dispatcher', async () => {
    const removed: string[] = []
    expect(await rm(files(removed), ['/m/a.txt'])).toEqual([0, '', ''])
    expect(removed).toEqual(['/m/a.txt'])
  })

  it('-v walks the tree through the dispatcher', async () => {
    const removed: string[] = []
    expect(await rm(files(removed), ['/m/d'], { r: true, v: true })).toEqual([
      0,
      "removed '/m/d/x.txt'\nremoved directory '/m/d'\n",
      '',
    ])
    expect(removed).toEqual(['/m/d'])
  })

  it('-f reports an existing file it cannot remove', async () => {
    // GNU rm -f spares ENOENT and ENOTDIR alone: a file
    // that exists on a filesystem refusing the unlink fails under -f too.
    expect(await rm(files(), ['/m/a.txt', '/m/nope'], { f: true })).toEqual([
      1,
      '',
      "rm: cannot remove '/m/a.txt': Operation not supported\n",
    ])
  })

  it('reports a refused stat in its own words and removes the rest', async () => {
    const removed: string[] = []
    expect(await rm(files(removed), ['/m/locked/f.txt', '/m/a.txt'], { f: true })).toEqual([
      1,
      '',
      "rm: cannot remove '/m/locked/f.txt': Permission denied\n",
    ])
    expect(removed).toEqual(['/m/a.txt'])
  })
})

// Mirrors test_rm_refused_operand_keeps_spelling_and_continues.
it.each([
  [
    false,
    'ELOOP',
    'loop/child',
    1,
    "rm: cannot remove 'loop/child': Too many levels of symbolic links\n",
  ],
  [true, 'ENOENT', '', 0, ''],
] as const)(
  'rm handles a refused operand under -f=%s (%s) and continues',
  async (force, refusal, raw, code, err) => {
    const stat = vi.fn((path: PathSpec) => {
      if (path.walkError !== null) throw walkRefusal(path)
      return new FileStat({ name: 'ok', type: FileType.FILE })
    })
    const unlink = vi.fn(() => null)
    const vfs = answeringFiles({
      readdir: () => [],
      stat,
      unlink,
      rmdir: unlink,
      rm_r: unlink,
    })
    const command = generic('rm')
    const refused = new PathSpec({
      virtual: '/data',
      directory: '/',
      vfsPath: 'data',
      rawPath: raw,
      walkError: refusal,
    })
    const valid = PathSpec.fromStrPath('/data/ok')
    const result = await runWithMountGate('/', MountMode.WRITE, async () =>
      command.fn({} as Accessor, [refused, valid], [], {
        flags: { f: force },
        stdin: null,
        cwd: PathSpec.fromStrPath('/'),
        vfs,
      }),
    )
    await materialize(result?.[0] ?? null)
    expect(result?.[1].exitCode).toBe(code)
    expect(new TextDecoder().decode(await materialize(result?.[1].stderr ?? null))).toBe(err)
    expect(stat).toHaveBeenCalledTimes(2)
    expect(unlink.mock.calls).toHaveLength(1)
  },
)

// Mirrors test_rm_r_names_a_mount_below_and_fails.
it('rm -r names a mount below and fails', async () => {
  const tree: Record<string, string[]> = { '/data': ['/data/a.txt', '/data/inner'] }
  const unlink = vi.fn((_path: PathSpec) => null)
  const rmdir = vi.fn(() => null)
  const vfs = answeringFiles(
    {
      readdir: (path) => tree[path.virtual] ?? [],
      stat: (path) =>
        new FileStat({
          name: path.virtual,
          type: path.virtual in tree ? FileType.DIRECTORY : FileType.FILE,
        }),
      unlink,
      rmdir,
      rm_r: (path) => {
        throw walkDeclined('s3', 'rm_r', path)
      },
    },
    {},
    ['/data/', '/data/inner/'],
  )
  const command = generic('rm')
  const result = await runWithMountGate('/data/', MountMode.WRITE, async () =>
    command.fn({} as Accessor, [PathSpec.fromStrPath('/data')], [], {
      flags: { r: true },
      stdin: null,
      cwd: PathSpec.fromStrPath('/'),
      vfs,
    }),
  )
  await materialize(result?.[0] ?? null)
  expect(result?.[1].exitCode).toBe(1)
  expect(new TextDecoder().decode(await materialize(result?.[1].stderr ?? null))).toBe(
    "rm: skipping '/data/inner', since it's on a different device\n",
  )
  expect(unlink.mock.calls.map((call) => call[0])).toEqual([PathSpec.fromStrPath('/data/a.txt')])
  expect(rmdir).not.toHaveBeenCalled()
})
