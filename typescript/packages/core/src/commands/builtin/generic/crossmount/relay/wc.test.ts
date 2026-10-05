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

// Mirrors python/tests/commands/builtin/generic/crossmount/relay/test_wc.py.

import { expect, it } from 'vitest'
import { command, type CommandFn } from '../../../../config.ts'
import { SPECS } from '../../../../spec/index.ts'
import { IOResult, materialize } from '../../../../../io/types.ts'
import { FileStat, FileType, MountMode, PathSpec } from '../../../../../types.ts'
import type { FlagValue } from '../../../../spec/types.ts'
import { enoent } from '../../../../../utils/errors.ts'
import { RAMVFS } from '../../../../../vfs/ram/ram.ts'
import { Workspace } from '../../../../../workspace/workspace/workspace.ts'
import { getTestParser } from '../../../../../workspace/fixtures/workspace_fixture.ts'
import type { CrossResult } from '../types.ts'
import { runWc } from './wc.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

// What each operand's own mount counts for `wc -l`, and what stat says. The
// printed text is never read back, so every run prints the same noise.
const ROWS: Record<string, [number[], string | null]> = {
  '/a/dir': [[0], 'wc: /a/dir: Is a directory\n'],
  '/b/name with spaces': [[1], null],
  '/b/x': [[1], null],
  '/pg/rows': [[5], null],
  '/pg2/rows': [[3], null],
  '/gone': [[4], null],
}
const SIZES: Record<string, number | null> = {
  '/b/name with spaces': 6,
  '/b/x': 120,
}

class Mounts {
  runs: [string, string[], Record<string, FlagValue>][] = []
  ops: string[] = []

  runSingle = (
    name: string,
    paths: PathSpec[],
    _texts: string[],
    flags: Record<string, FlagValue>,
  ): Promise<CrossResult> => {
    this.runs.push([name, paths.map((p) => p.virtual), flags])
    const [values, err] = ROWS[paths[0]?.virtual ?? ''] ?? [[], null]
    return Promise.resolve([
      ENC.encode('9 9 9 rendered\n'),
      new IOResult({
        exitCode: err === null ? 0 : 1,
        stderr: err === null ? null : ENC.encode(err),
        countedRuns: [{ values, label: paths[0]?.rawPath ?? null }],
      }),
    ])
  }

  dispatch = (op: string, path: PathSpec): Promise<[unknown, IOResult]> => {
    this.ops.push(op)
    if (path.virtual === '/gone') return Promise.reject(enoent(path))
    const type = path.virtual === '/a/dir' ? FileType.DIRECTORY : FileType.FILE
    const stat = new FileStat({ name: path.virtual, type, size: SIZES[path.virtual] ?? null })
    return Promise.resolve([stat, new IOResult()])
  }
}

function specs(...paths: string[]): PathSpec[] {
  return paths.map((p) => PathSpec.fromStrPath(p))
}

it.each([
  [{ lines: true }, '      0 /a/dir\n      1 /b/name with spaces\n      1 total\n'],
  [{ lines: true, total: 'only' }, '1\n'],
  [{ lines: true, total: 'never' }, '      0 /a/dir\n      1 /b/name with spaces\n'],
] as [Record<string, FlagValue>, string][])(
  'each mount counts its operand: %j',
  async (flags, expected) => {
    const mounts = new Mounts()
    const [body, io] = await runWc(
      specs('/a/dir', '/b/name with spaces'),
      flags,
      mounts.dispatch,
      mounts.runSingle,
    )
    expect(DEC.decode(await materialize(body))).toBe(expected)
    expect(mounts.runs).toEqual([
      ['wc', ['/a/dir'], { ...flags, total: 'never' }],
      ['wc', ['/b/name with spaces'], { ...flags, total: 'never' }],
    ])
    expect(mounts.ops).not.toContain('read')
    expect(io.exitCode).toBe(1)
    expect(DEC.decode(await materialize(io.stderr))).toBe('wc: /a/dir: Is a directory\n')
  },
)

it.each([
  [['/pg/rows', '/pg2/rows'], '5 /pg/rows\n3 /pg2/rows\n8 total\n'],
  [['/pg/rows', '/b/x'], '  5 /pg/rows\n  1 /b/x\n  6 total\n'],
])('an unsized file pads to its count: %j', async (paths, expected) => {
  const mounts = new Mounts()
  const [body, io] = await runWc(
    specs(...paths),
    { lines: true },
    mounts.dispatch,
    mounts.runSingle,
  )
  expect(DEC.decode(await materialize(body))).toBe(expected)
  expect(io.exitCode).toBe(0)
})

it('keeps every count when a file is gone before sizing', async () => {
  const mounts = new Mounts()
  const [body, io] = await runWc(
    specs('/gone', '/b/x'),
    { lines: true },
    mounts.dispatch,
    mounts.runSingle,
  )
  expect(DEC.decode(await materialize(body))).toBe('  4 /gone\n  1 /b/x\n  5 total\n')
  expect(io.exitCode).toBe(0)
})

it('rejects an invalid total before any mount runs', async () => {
  const mounts = new Mounts()
  const [, io] = await runWc(
    specs('/a/x', '/b/x'),
    { total: 'bogus' },
    mounts.dispatch,
    mounts.runSingle,
  )
  expect(io.exitCode).toBe(1)
  expect(DEC.decode(await materialize(io.stderr))).toContain("invalid argument 'bogus'")
  expect(mounts.runs).toEqual([])
  expect(mounts.ops).toEqual([])
})

const uncounted: CommandFn = (_accessor, paths) => [
  ENC.encode(`777 ${paths[0]?.rawPath ?? ''}\n`),
  new IOResult(),
]

const rowCount: CommandFn = (_accessor, paths) => [
  new Uint8Array(0),
  new IOResult({ countedRuns: [{ values: [42], label: paths[0]?.rawPath ?? null }] }),
]

it('recounts a wc without counts alone', async () => {
  // /b's wc renders text only, so its operand is recounted through the
  // dispatcher; /a's own count (a row count it never read for) stays.
  // Mirrors Python's test_a_wc_without_counts_is_recounted_alone.
  const first = new RAMVFS()
  const second = new RAMVFS()
  first.loadState({ type: 'ram', files: { '/x': ENC.encode('a\nb\n') } })
  second.loadState({ type: 'ram', files: { '/y': ENC.encode('c\n') } })
  const ws = new Workspace(
    { '/a': first, '/b': second },
    { mode: MountMode.WRITE, shellParser: await getTestParser() },
  )
  const spec = SPECS.wc
  if (spec === undefined) throw new Error('Missing spec: wc')
  for (const cmd of command({ name: 'wc', vfs: 'ram', spec, fn: rowCount }))
    ws.registry.mountFor('/a/x').register(cmd)
  for (const cmd of command({ name: 'wc', vfs: 'ram', spec, fn: uncounted }))
    ws.registry.mountFor('/b/y').register(cmd)
  try {
    const result = await ws.shell('wc -l /a/x /b/y')
    expect(DEC.decode(result.stdout)).toBe('42 /a/x\n1 /b/y\n43 total\n')
    expect(result.exitCode).toBe(0)
  } finally {
    await ws.close()
  }
})
