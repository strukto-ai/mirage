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
import { MountMode, type PathSpec } from '../../types.ts'
import type { Handed } from '../../vfs/types.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'

describe('a warm read command reads nothing from the backend', () => {
  // Every read command reads at the dispatcher, which serves the warm entry
  // whatever reader the command binds.
  it.each([
    'cat /c/a.txt',
    'head -n 1 /c/a.txt',
    'tail -n 1 /c/a.txt',
    'wc -l /c/a.txt',
    'grep alpha /c/a.txt',
    'rg alpha /c/a.txt',
  ])('%s', async (line) => {
    const ram = new RAMVFS()
    Object.assign(ram, { cachesReads: true })
    const ws = new Workspace(
      { '/c': ram },
      {
        mode: MountMode.WRITE,
      },
    )
    try {
      await ws.shell("printf 'alpha\\nbeta\\n' > /c/a.txt")
      await ws.shell('cat /c/a.txt')
      const reads: string[] = []
      const read = ram.read.bind(ram)
      Object.assign(ram, {
        read: (path: PathSpec, ...rest: [Handed?, number?, (number | null)?]) => {
          reads.push(path.virtual)
          return read(path, ...rest)
        },
      })
      const out = await ws.shell(line)
      expect(out.stdout.byteLength).toBeGreaterThan(0)
      expect(out.exitCode).toBe(0)
      expect(reads).toEqual([])
    } finally {
      await ws.close()
    }
  })
})

it.each([
  ['tail -n 1 /c/a', 'beta\n', 0],
  ['tail -c 5 /c/a', 'beta\n', 0],
  ['cmp -l /c/a /c/b', ' 1 141 101\n 7 142 102\n', 1],
] as const)('sized commands use the warm body length: %s', async (line, expected, code) => {
  const ram = new RAMVFS()
  Object.assign(ram, { cachesReads: true })
  const enc = new TextEncoder()
  ram.store.files.set('/a', enc.encode('alpha\nbeta\n'))
  ram.store.files.set('/b', enc.encode('Alpha\nBeta\n'))
  const ws = new Workspace({ '/c': ram }, { mode: MountMode.WRITE })
  try {
    await ws.shell('cat /c/a /c/b')
    ram.store.files.set('/a', enc.encode('x'))
    ram.store.files.set('/b', enc.encode('y'))
    const out = await ws.shell(line)
    expect(new TextDecoder().decode(out.stdout)).toBe(expected)
    expect(out.exitCode).toBe(code)
  } finally {
    await ws.close()
  }
})

it.each(['-n 1', '-c 4'])('tail rechecks a stale listing size: %s', async (option) => {
  const ram = new RAMVFS()
  Object.assign(ram, { indexTtl: 60 })
  const enc = new TextEncoder()
  ram.store.files.set('/a', enc.encode('old\n'))
  const ws = new Workspace({ '/c': ram }, { mode: MountMode.WRITE })
  try {
    await ws.shell('ls /c')
    ram.store.files.set('/a', enc.encode('old\nnew\n'))
    const out = await ws.shell(`tail ${option} /c/a`)
    expect(new TextDecoder().decode(out.stdout)).toBe('new\n')
    expect(out.exitCode).toBe(0)
  } finally {
    await ws.close()
  }
})
