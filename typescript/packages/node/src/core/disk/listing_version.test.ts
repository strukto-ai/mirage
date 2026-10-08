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

import {
  closeSync,
  mkdirSync,
  openSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as UtilsModule from './utils.ts'
import { RAMIndexCacheStore } from '@struktoai/mirage-core/cache/index/ram'
import type { FileStat } from '@struktoai/mirage-core/types'
import { MountMode, PathSpec, ReadPolicy } from '@struktoai/mirage-core/types'
import { Mount } from '@struktoai/mirage-core/workspace/mount/spec'
import { Reconciler } from '@struktoai/mirage-core/workspace/reconcile'
import { tmpRoot } from '../../test-utils.ts'
import { DiskVFS } from '../../vfs/disk/disk.ts'
import { Workspace } from '../../workspace.ts'
import { folderVersion } from './listing_version.ts'
import * as utils from './utils.ts'

vi.mock('./utils.ts', async (importOriginal) => {
  const original = await importOriginal<typeof UtilsModule>()
  return { ...original, readEntries: vi.fn(original.readEntries) }
})

const DEC = new TextDecoder()
const QUIET_MS = 3000
// A whole second, so a put-back mtime is exact (utimes takes seconds as a
// double and would round nanoseconds).
const OLD_S = 1000000000
const OLD_NS = 1000000000000000000n

let root: string
let cleanup: () => void
let scans: string[]
let checks: string[]

function changedNs(folder: string): bigint {
  const st = statSync(folder, { bigint: true })
  return st.ctimeNs > st.mtimeNs ? st.ctimeNs : st.mtimeNs
}

// The clock rule: 3 s past the latest change of every folder given, re-read
// after each outside change, so the racy guard never withholds a version.
function settle(...folders: string[]): void {
  const latest = folders.map(changedNs).reduce((a, b) => (a > b ? a : b))
  vi.setSystemTime(Number(latest / 1000000n) + QUIET_MS)
}

// Set a folder's mtime a minute past its ctime; return both as stat reads
// them back.
function mtimeAhead(folder: string): [bigint, bigint] {
  const ctime = statSync(folder, { bigint: true }).ctimeNs
  const seconds = Number(ctime / 1000000n) / 1000
  utimesSync(folder, seconds, seconds + 60)
  const st = statSync(folder, { bigint: true })
  expect(st.mtimeNs > st.ctimeNs).toBe(true)
  return [st.ctimeNs, st.mtimeNs]
}

function expected(folder: string): string {
  const st = statSync(folder, { bigint: true })
  return `${String(st.dev)}:${String(st.ino)}:${String(st.ctimeNs)}:${String(st.mtimeNs)}`
}

function workspace(folderVersions?: boolean): Workspace {
  const vfs = new DiskVFS(folderVersions === undefined ? { root } : { root, folderVersions })
  return new Workspace({
    '/m': new Mount(vfs, { mode: MountMode.WRITE, read: { policy: ReadPolicy.FRESH, ttl: 600 } }),
  })
}

async function ls(ws: Workspace, path = '/m'): Promise<string> {
  const result = await ws.shell(`ls ${path}`)
  expect([result.exitCode, DEC.decode(result.stderr)], path).toEqual([0, ''])
  return DEC.decode(result.stdout)
}

async function stored(ws: Workspace, key = '/m'): Promise<string | null> {
  return (await ws.registry.mountFor(key).indexStore.listDir(key)).version ?? null
}

async function checked(ws: Workspace, key = '/m'): Promise<string | null> {
  const mount = ws.registry.mountFor(key)
  const vfsPath = key === '/m' ? '' : key.slice('/m/'.length)
  const spec = new PathSpec({ virtual: key, directory: key, vfsPath })
  const remote = (await mount.callOp('stat', spec, [], {
    index: new RAMIndexCacheStore(),
  })) as FileStat
  return remote.fingerprint ?? null
}

beforeEach(() => {
  ;({ root, cleanup } = tmpRoot('mirage-disk-listing-version-'))
  vi.useFakeTimers({ toFake: ['Date'] })
  scans = []
  checks = []
  vi.mocked(utils.readEntries).mockImplementation(async (directory: string) => {
    scans.push(directory)
    return (await vi.importActual<typeof UtilsModule>('./utils.ts')).readEntries(directory)
  })
  const proto = Reconciler.prototype as unknown as {
    listingFingerprint: (mount: unknown, path: string) => Promise<string | null>
  }
  const original = proto.listingFingerprint
  vi.spyOn(proto, 'listingFingerprint').mockImplementation(async function (
    this: unknown,
    mount: unknown,
    path: string,
  ) {
    checks.push(path)
    return original.call(this, mount, path)
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.mocked(utils.readEntries).mockReset()
  vi.useRealTimers()
  cleanup()
})

describe('folderVersion', () => {
  it('is withheld while the folder changed within two seconds', async () => {
    const changed = changedNs(root)
    expect(await folderVersion(root, changed + 1999999999n)).toBeNull()
    expect(await folderVersion(root, changed + 2000000000n)).not.toBeNull()
  })

  it('is withheld while the ctime is fresh, however old the mtime', async () => {
    utimesSync(root, OLD_S, OLD_S)
    const st = statSync(root, { bigint: true })
    expect(st.mtimeNs).toBe(OLD_NS)
    expect(await folderVersion(root, st.ctimeNs + 1000000000n)).toBeNull()
  })
})

describe('disk folder versions under fresh', () => {
  it('a quiet folder stores the version its stat answers', async () => {
    writeFileSync(join(root, 'a.txt'), 'a')
    settle(root)
    const ws = workspace()
    try {
      expect(await ls(ws)).toBe('a.txt\n')
      const version = await stored(ws)
      expect(version).toBe(expected(root))
      expect(await checked(ws)).toBe(version)
    } finally {
      await ws.close()
    }
  })

  // Where ctime is a creation time, the mtime is what a change moves, so a
  // folder whose mtime is ahead of the clock is still settling however long
  // ago its ctime was.
  it('a folder whose mtime is ahead is re-listed until the clock passes it', async () => {
    writeFileSync(join(root, 'a.txt'), 'a')
    const [ctime, mtime] = mtimeAhead(root)
    vi.setSystemTime(Number(ctime / 1000000n) + QUIET_MS)
    const ws = workspace()
    try {
      await ls(ws)
      expect(await stored(ws)).toBeNull()
      vi.setSystemTime(Number(mtime / 1000000n) + QUIET_MS)
      await ls(ws)
      expect(await stored(ws)).toBe(expected(root))
      expect(scans).toEqual([root, root])
    } finally {
      await ws.close()
    }
  })

  it('an add with its mtime put back still moves the version', async () => {
    writeFileSync(join(root, 'a.txt'), 'a')
    utimesSync(root, OLD_S, OLD_S)
    settle(root)
    const ws = workspace()
    try {
      await ls(ws)
      const version = await stored(ws)
      expect(version).not.toBeNull()
      writeFileSync(join(root, 'b.txt'), 'b')
      utimesSync(root, OLD_S, OLD_S)
      expect(statSync(root, { bigint: true }).mtimeNs).toBe(OLD_NS)
      settle(root)
      const moved = await checked(ws)
      expect(moved).not.toBeNull()
      expect(moved).not.toBe(version)
      expect(await ls(ws)).toBe('a.txt\nb.txt\n')
    } finally {
      await ws.close()
    }
  })

  it('a folder made again under its old mtime moves the version', async () => {
    const folder = join(root, 'd')
    mkdirSync(folder)
    writeFileSync(join(folder, 'x.txt'), 'x')
    utimesSync(folder, OLD_S, OLD_S)
    settle(folder)
    const ws = workspace()
    try {
      expect(await ls(ws, '/m/d')).toBe('x.txt\n')
      const version = await stored(ws, '/m/d')
      expect(version).not.toBeNull()
      rmSync(folder, { recursive: true })
      mkdirSync(folder)
      writeFileSync(join(folder, 'y.txt'), 'y')
      utimesSync(folder, OLD_S, OLD_S)
      expect(statSync(folder, { bigint: true }).mtimeNs).toBe(OLD_NS)
      settle(folder)
      const moved = await checked(ws, '/m/d')
      expect(moved).not.toBeNull()
      expect(moved).not.toBe(version)
      expect(await ls(ws, '/m/d')).toBe('y.txt\n')
    } finally {
      await ws.close()
    }
  })

  it('an in-place edit of a child keeps the listing served', async () => {
    const child = join(root, 'c.txt')
    writeFileSync(child, 'abc')
    settle(root)
    const ws = workspace()
    try {
      await ls(ws)
      const version = await stored(ws)
      expect(version).not.toBeNull()
      const fd = openSync(child, 'r+')
      writeSync(fd, 'X', 0)
      closeSync(fd)
      settle(root)
      expect(await checked(ws)).toBe(version)
      expect(await ls(ws)).toBe('c.txt\n')
      expect(scans).toEqual([root])
      expect(checks).toEqual(['/m'])
    } finally {
      await ws.close()
    }
  })

  it('a file made during the scan is seen by the next command', async () => {
    writeFileSync(join(root, 'a.txt'), 'a')
    settle(root)
    const actual = (await vi.importActual<typeof UtilsModule>('./utils.ts')).readEntries
    let made = false
    vi.mocked(utils.readEntries).mockImplementation(async (directory: string) => {
      scans.push(directory)
      const rows = await actual(directory)
      if (!made) {
        made = true
        writeFileSync(join(directory, 'late.txt'), 'l')
      }
      return rows
    })
    const ws = workspace()
    try {
      expect(await ls(ws)).toBe('a.txt\n')
      expect(await stored(ws)).not.toBeNull()
      settle(root)
      expect(await ls(ws)).toBe('a.txt\nlate.txt\n')
      expect(scans).toEqual([root, root])
    } finally {
      await ws.close()
    }
  })

  it('folderVersions off re-lists every command', async () => {
    writeFileSync(join(root, 'a.txt'), 'a')
    settle(root)
    const ws = workspace(false)
    try {
      await ls(ws)
      expect(await stored(ws)).toBeNull()
      await ls(ws)
      expect(checks).toEqual([])
      expect(scans).toEqual([root, root])
    } finally {
      await ws.close()
    }
  })
})
