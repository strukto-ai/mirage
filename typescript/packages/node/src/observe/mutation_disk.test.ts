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

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MountMode } from '@struktoai/mirage-core/types'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DiskVFS } from '../vfs/disk/disk.ts'
import { Workspace } from '../workspace.ts'

const MUTATIONS = new Set(['copy', 'rename', 'rename_prefix', 'unlink', 'rmdir', 'rm_r'])

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mirage-obs-mutation-'))
  writeFileSync(join(root, 'a.txt'), 'hello\n')
  mkdirSync(join(root, 'e'))
  mkdirSync(join(root, 'd'))
  writeFileSync(join(root, 'd', 'f.txt'), 'f\n')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

async function rows(line: string): Promise<[string, string, number][]> {
  const ws = new Workspace({ '/m': new DiskVFS({ root }) }, { mode: MountMode.WRITE })
  try {
    const start = ws.records.length
    const io = await ws.shell(line)
    expect(io.exitCode, new TextDecoder().decode(io.stderr)).toBe(0)
    const recs = ws.records.slice(start)
    expect(recs.every((r) => r.executionId !== null)).toBe(true)
    return recs
      .filter((r) => MUTATIONS.has(r.op) && r.source === 'disk')
      .map((r) => [r.op, r.path, r.bytes])
  } finally {
    await ws.close()
  }
}

describe('disk mutations record the object-store rows', () => {
  it.each<[string, [string, string, number][]]>([
    ['cp /m/a.txt /m/c.txt', [['copy', '/m/c.txt', 0]]],
    ['cp -r /m/d /m/d2', [['copy', '/m/d2/f.txt', 0]]],
    [
      'mv /m/a.txt /m/b.txt',
      [
        ['rename', '/m/a.txt', 0],
        ['rename', '/m/b.txt', 0],
      ],
    ],
    [
      'mv /m/d /m/d2',
      [
        ['rename_prefix', '/m/d', 0],
        ['rename_prefix', '/m/d2', 0],
      ],
    ],
    ['rm /m/a.txt', [['unlink', '/m/a.txt', 0]]],
    ['mkdir /m/x', []],
    ['rmdir /m/e', [['rmdir', '/m/e', 0]]],
    ['rm -r /m/d', [['rm_r', '/m/d', 0]]],
  ])('%s', async (line, expected) => {
    expect(await rows(line)).toEqual(expected)
  })
})
