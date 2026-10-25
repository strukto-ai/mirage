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

import type * as ChildProcess from 'node:child_process'
import type * as Fs from 'node:fs'
import { chmodSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  appendDirectIO,
  appendMountOptions,
  canonicalMountpoint,
  driverHint,
  forceUnmount,
  unmountWithFusermount,
} from './mount.ts'
import { UNMOUNT_POLL_MS, UNMOUNT_TIMEOUT_MS } from './constants.ts'

const { execFile, execFileSync, mountTable } = vi.hoisted(() => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
  mountTable: { text: '' },
}))
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcess>()),
  execFile,
  execFileSync,
}))
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof Fs>()
  return {
    ...fs,
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) =>
      args[0] === '/proc/self/mounts' ? mountTable.text : fs.readFileSync(...args),
  }
})

function fakeFuse(serialize?: () => string) {
  const nop = (cb: (err: Error | null) => void): void => {
    cb(null)
  }
  return {
    mount: nop,
    unmount: nop,
    ...(serialize !== undefined ? { _fuseOptions: serialize } : {}),
  }
}

describe('appendDirectIO', () => {
  it('appends direct_io to a non-empty option string', () => {
    const fuse = fakeFuse(() => '-oforce,attr_timeout=0')
    appendDirectIO(fuse)
    expect(fuse._fuseOptions?.()).toBe('-oforce,attr_timeout=0,direct_io')
  })

  it('emits -odirect_io when no other option serializes', () => {
    const fuse = fakeFuse(() => '')
    appendDirectIO(fuse)
    expect(fuse._fuseOptions?.()).toBe('-odirect_io')
  })

  it('does not double-append when direct_io is already present', () => {
    const fuse = fakeFuse(() => '-odirect_io,attr_timeout=0')
    appendDirectIO(fuse)
    expect(fuse._fuseOptions?.()).toBe('-odirect_io,attr_timeout=0')
  })

  it('throws when the serializer hook is gone (fork version drift)', () => {
    const fuse = fakeFuse()
    expect(() => {
      appendDirectIO(fuse)
    }).toThrow('_fuseOptions')
  })
})

describe('appendMountOptions', () => {
  it('appends the fskit recipe: backend=fskit + volname, no direct_io', () => {
    // Issue #82's verified mount options, exactly what mount() appends for
    // an fskit mount. Verified live; see examples/typescript/fuse/fskit.ts.
    const fuse = fakeFuse(() => '-oattr_timeout=0')
    appendMountOptions(fuse, ['backend=fskit', 'volname=mirage-abc'])
    expect(fuse._fuseOptions?.()).toBe('-oattr_timeout=0,backend=fskit,volname=mirage-abc')
  })

  it('emits -o<extras> when no other option serializes', () => {
    const fuse = fakeFuse(() => '')
    appendMountOptions(fuse, ['backend=fskit', 'volname=v'])
    expect(fuse._fuseOptions?.()).toBe('-obackend=fskit,volname=v')
  })

  it('appends only the options not already present', () => {
    const fuse = fakeFuse(() => '-obackend=fskit')
    appendMountOptions(fuse, ['backend=fskit', 'volname=v'])
    expect(fuse._fuseOptions?.()).toBe('-obackend=fskit,volname=v')
  })
})

describe('driverHint', () => {
  it('names the driver for the platform that has one', () => {
    expect(driverHint('darwin')).toMatch(/macFUSE/)
    expect(driverHint('linux')).toMatch(/fuse3/)
  })

  // fuse-native's Windows path builds against Dokany, not WinFsp, so
  // recommending WinFsp would send a Windows reader after a driver that
  // cannot make this load (docs/typescript/setup/fuse.mdx).
  it('reports Windows as unsupported instead of naming WinFsp', () => {
    const hint = driverHint('win32')
    expect(hint).not.toMatch(/install WinFsp/i)
    expect(hint).toMatch(/does not support WinFsp/)
    expect(hint).toMatch(/macOS and Linux only/)
  })
})

const REAL_PLATFORM = process.platform
const REAL_PATH = process.env.PATH
const helperDirs: string[] = []

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: REAL_PLATFORM, configurable: true })
  process.env.PATH = REAL_PATH
  vi.useRealTimers()
  execFile.mockReset()
  execFileSync.mockReset()
  mountTable.text = ''
  for (const dir of helperDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function helperDir(executable: string[], plain: string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), 'mirage-fusermount-'))
  helperDirs.push(dir)
  for (const name of [...executable, ...plain]) writeFileSync(join(dir, name), '')
  for (const name of executable) chmodSync(join(dir, name), 0o755)
  return dir
}

function unmountOnLinux(pathDirs: string[]): void {
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
  process.env.PATH = pathDirs.join(delimiter)
  forceUnmount('/mnt/m')
}

function unmountVia(mountpoint: string, failure: Error | null, stderr = ''): Promise<Error | null> {
  execFile.mockImplementation(
    (
      _file: string,
      _args: string[],
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      cb(failure, '', stderr)
      return { unref: vi.fn() }
    },
  )
  return new Promise((done) => {
    unmountWithFusermount(mountpoint, done)
  })
}

// A helper whose exit node reports late, or never: the unmount settles on the
// mount table, exactly once, and the child does not hold the process open.
function unmountWithLateExit(mountpoint: string, cb = vi.fn()) {
  const unref = vi.fn()
  let report: ((err: Error | null, stdout: string, stderr: string) => void) | undefined
  execFile.mockImplementation(
    (
      _file: string,
      _args: string[],
      done: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      report = done
      return { unref }
    },
  )
  unmountWithFusermount(mountpoint, cb)
  return {
    cb,
    unref,
    exit: (failure: Error | null) => {
      report?.(failure, '', '')
    },
  }
}

function markMounted(mountpoint: string): void {
  mountTable.text = `mirage ${mountpoint.replaceAll(' ', '\\040')} fuse.mirage rw 0 0\n`
}

describe('forceUnmount', () => {
  it('prefers fusermount anywhere on PATH over an earlier fusermount3', () => {
    const three = helperDir(['fusermount3'])
    const legacy = helperDir(['fusermount'])
    unmountOnLinux([three, legacy])
    expect(execFileSync).toHaveBeenCalledWith(join(legacy, 'fusermount'), ['-u', '/mnt/m'], {
      stdio: 'ignore',
    })
  })

  it('falls back to fusermount3 past a fusermount it cannot execute', () => {
    const dir = helperDir(['fusermount3'], ['fusermount'])
    unmountOnLinux([dir])
    expect(execFileSync).toHaveBeenCalledWith(join(dir, 'fusermount3'), ['-u', '/mnt/m'], {
      stdio: 'ignore',
    })
  })

  it('keeps searching past a fusermount that is a symlink loop', () => {
    const loop = helperDir([])
    symlinkSync('fusermount', join(loop, 'fusermount'))
    const three = helperDir(['fusermount3'])
    unmountOnLinux([loop, three])
    expect(execFileSync).toHaveBeenCalledWith(join(three, 'fusermount3'), ['-u', '/mnt/m'], {
      stdio: 'ignore',
    })
  })

  it('runs nothing when neither helper is on PATH', () => {
    unmountOnLinux([helperDir([])])
    expect(execFileSync).not.toHaveBeenCalled()
  })
})

describe('canonicalMountpoint', () => {
  it('resolves a symlinked parent', () => {
    const real = helperDir([])
    const parent = helperDir([])
    symlinkSync(real, join(parent, 'link'))
    expect(canonicalMountpoint(join(parent, 'link', 'mp'))).toBe(join(realpathSync(real), 'mp'))
  })
})

describe('unmountWithFusermount', () => {
  it('treats a mount already gone as unmounted when the helper fails', async () => {
    process.env.PATH = helperDir(['fusermount3'])
    const mountpoint = join(realpathSync(helperDir([])), 'my mount')
    await expect(unmountVia(mountpoint, new Error('not found in /etc/mtab'))).resolves.toBeNull()
  })

  it('treats a mountpoint whose parent is gone as unmounted', async () => {
    process.env.PATH = helperDir(['fusermount3'])
    const mountpoint = join(helperDir([]), 'gone', 'my mount')
    await expect(unmountVia(mountpoint, new Error('not found in /etc/mtab'))).resolves.toBeNull()
  })

  it('reports a helper failure while the path is still mounted', async () => {
    const helpers = helperDir(['fusermount3'])
    process.env.PATH = helpers
    const mountpoint = join(realpathSync(helperDir([])), 'my mount')
    markMounted(mountpoint)
    const busy = new Error('Command failed')
    const err = await unmountVia(mountpoint, busy, 'fusermount3: device or resource busy\n')
    expect(err?.message).toBe(`cannot unmount ${mountpoint}: fusermount3: device or resource busy`)
    expect(err?.cause).toBe(busy)
    expect(execFile).toHaveBeenCalledWith(
      join(helpers, 'fusermount3'),
      ['-uz', mountpoint],
      expect.any(Function),
    )
  })

  it('settles on the mount table, once, when the helper exit comes late', async () => {
    vi.useFakeTimers()
    process.env.PATH = helperDir(['fusermount3'])
    const mountpoint = join(realpathSync(helperDir([])), 'my mount')
    markMounted(mountpoint)
    const { cb, unref, exit } = unmountWithLateExit(mountpoint)
    expect(unref).toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(UNMOUNT_POLL_MS * 3)
    expect(cb).not.toHaveBeenCalled()
    mountTable.text = ''
    await vi.advanceTimersByTimeAsync(UNMOUNT_POLL_MS)
    exit(new Error('Command failed'))
    expect(cb.mock.calls).toEqual([[null]])
  })

  it('gives up, once, on a mount still listed when the helper exit comes late', async () => {
    vi.useFakeTimers()
    process.env.PATH = helperDir(['fusermount3'])
    const mountpoint = join(realpathSync(helperDir([])), 'my mount')
    markMounted(mountpoint)
    const { cb, exit } = unmountWithLateExit(mountpoint)
    await vi.advanceTimersByTimeAsync(UNMOUNT_TIMEOUT_MS)
    exit(null)
    expect(cb).toHaveBeenCalledTimes(1)
    expect((cb.mock.calls[0]?.[0] as Error).message).toBe(
      `cannot unmount ${mountpoint}: still mounted after ${String(UNMOUNT_TIMEOUT_MS)} ms`,
    )
  })

  it('lets an error the callback throws escape the poll', async () => {
    vi.useFakeTimers()
    process.env.PATH = helperDir(['fusermount3'])
    const mountpoint = join(realpathSync(helperDir([])), 'my mount')
    const boom = new Error('boom')
    unmountWithLateExit(
      mountpoint,
      vi.fn(() => {
        throw boom
      }),
    )
    await expect(vi.advanceTimersByTimeAsync(UNMOUNT_POLL_MS)).rejects.toBe(boom)
  })

  it('fails without a helper only while the path is still mounted', async () => {
    process.env.PATH = helperDir([])
    const mountpoint = join(realpathSync(helperDir([])), 'my mount')
    await expect(unmountVia(mountpoint, null)).resolves.toBeNull()
    markMounted(mountpoint)
    const err = await unmountVia(mountpoint, null)
    expect(err?.message).toMatch(/neither 'fusermount' nor 'fusermount3'/)
    expect(execFile).not.toHaveBeenCalled()
  })
})
