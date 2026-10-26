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
import { enoent } from '../../errors/fs.ts'
import type { OpenMode } from '../handles/mode.ts'
import type { VFSStat } from '../types.ts'
import { DIR_MODE, FILE_MODE } from '../../utils/stat_view.ts'
import { FST_ATIM, FST_ATIM_NOW, FST_MTIM, FT_DIR, FT_REG } from './constants.ts'
import { EBADF, EIO, ENOENT, ENOTDIR, EPIPE, ESPIPE, OK } from './errors.ts'
import { GuestExit, type GuestFile, type GuestView, WasiFs, wasiImports } from './fs.ts'

const ENC = new TextEncoder()
const DIR: VFSStat = { size: 0, isDir: true, mode: DIR_MODE }
const FILE: VFSStat = { size: 4, isDir: false, mode: FILE_MODE }
// Where the tests put their arguments in the guest's memory.
const PATH = 1024
const OUT = 2048

/** A view over one directory holding one file, its calls recorded. */
function view(overrides: Partial<GuestView> = {}): GuestView & { calls: unknown[][] } {
  const calls: unknown[][] = []
  const rows: Record<string, VFSStat> = { '/': DIR, '/d': DIR, '/d/f.txt': FILE }
  const row = (path: string): VFSStat => {
    const found = rows[path.replace(/\/$/, '') || '/']
    if (found === undefined) throw enoent(path)
    return found
  }
  return {
    calls,
    stat: row,
    lstat: row,
    statOrNull: (path) => rows[path] ?? null,
    open: () => {
      throw enoent('/')
    },
    unlink: () => undefined,
    mkdir: () => undefined,
    rmdir: () => undefined,
    rename: () => undefined,
    symlink: () => undefined,
    walked: (path) => path,
    readlink: () => '',
    setattr: (...args) => {
      calls.push(['setattr', ...args])
    },
    readdir: () => [
      ['f.txt', FT_REG],
      ['sub', FT_DIR],
    ],
    ...overrides,
  }
}

/** A file whose calls are recorded and whose close may fail. */
function file(failClose: Error | null = null): GuestFile & { calls: string[] } {
  const calls: string[] = []
  const mode: OpenMode = {
    readable: true,
    writable: true,
    truncate: false,
    append: false,
    create: false,
    exclusive: false,
    binary: true,
  }
  return {
    calls,
    mode,
    opened: '/d/f.txt',
    inode: '/d/f.txt',
    path: () => '/d/f.txt',
    position: () => 0,
    size: () => 4,
    read: () => new Uint8Array(),
    pread: () => new Uint8Array(),
    write: () => {
      calls.push('write')
    },
    pwrite: () => undefined,
    seek: () => 0,
    truncate: () => undefined,
    land: () => {
      calls.push('land')
    },
    close: () => {
      calls.push('close')
      if (failClose !== null) throw failClose
    },
    fstat: () => FILE,
    unlinked: () => false,
  }
}

function guest(
  fs: GuestView,
  streams: {
    output?: (fd: 1 | 2, bytes: Uint8Array) => boolean
    wait?: (ms: number) => boolean
  } = {},
): WasiFs & { memory: WebAssembly.Memory } {
  const wasi = new WasiFs(
    fs,
    null,
    streams.output ?? (() => true),
    streams.wait ?? (() => false),
    ['qjs'],
    [],
  )
  wasi.memory = new WebAssembly.Memory({ initial: 1 })
  return wasi as WasiFs & { memory: WebAssembly.Memory }
}

function put(wasi: { memory: WebAssembly.Memory }, ptr: number, text: string): number {
  const bytes = ENC.encode(text)
  new Uint8Array(wasi.memory.buffer).set(bytes, ptr)
  return bytes.byteLength
}

function u32(wasi: { memory: WebAssembly.Memory }, ptr: number): number {
  return new DataView(wasi.memory.buffer).getUint32(ptr, true)
}

/** path_filestat_get through the import table, which maps errors to errno. */
function stat(wasi: WasiFs, path: string): number {
  const length = put(wasi as WasiFs & { memory: WebAssembly.Memory }, PATH, path)
  const call = wasiImports(wasi).wasi_snapshot_preview1 as unknown as {
    path_filestat_get: (...args: number[]) => number
  }
  return call.path_filestat_get(3, 1, PATH, length, OUT)
}

/** The view calls one path_filestat_set_times makes. */
function setTimes(fstFlags: number, atim: bigint, mtim: bigint): unknown[][] {
  const fs = view()
  const wasi = guest(fs)
  const length = put(wasi, PATH, 'd/f.txt')
  expect(wasi.path_filestat_set_times(3, 1, PATH, length, atim, mtim, fstFlags)).toBe(OK)
  return fs.calls
}

/** A guest with `handle` open, and its fd. */
function opened(handle: GuestFile): [WasiFs & { memory: WebAssembly.Memory }, number] {
  const wasi = guest(view({ open: () => handle }))
  const length = put(wasi, PATH, 'd/f.txt')
  expect(wasi.path_open(3, 1, PATH, length, 0, 1n << 6n, 0n, 0, OUT)).toBe(OK)
  return [wasi, u32(wasi, OUT)]
}

describe('wasiImports', () => {
  it('answers an fs error as its errno', () => {
    expect(stat(guest(view()), 'nope')).toBe(ENOENT)
  })

  it('answers EIO for an upstream failure, rather than trapping the run', () => {
    const failing = view({
      stat: () => {
        throw new Error('upstream 502 Bad Gateway')
      },
    })
    expect(stat(guest(failing), 'd')).toBe(EIO)
  })

  it('lets proc_exit end the guest', () => {
    const call = wasiImports(guest(view())).wasi_snapshot_preview1 as unknown as {
      proc_exit: (code: number) => never
    }
    expect(() => call.proc_exit(300)).toThrow(GuestExit)
  })
})

describe('stamps', () => {
  it('reads the argument as nanoseconds', () => {
    expect(setTimes(FST_MTIM, 0n, 200_000_000_000n)).toEqual([
      ['setattr', '/d/f.txt', null, '1970-01-01T00:03:20.000Z', false],
    ])
  })

  it('stamps nothing when no flag selects a field, as UTIME_OMIT', () => {
    expect(setTimes(0, 5n, 5n)).toEqual([])
  })

  it('reads the host clock when the now bit is set, whatever the argument', () => {
    const [call] = setTimes(FST_ATIM | FST_ATIM_NOW, 200_000_000_000n, 0n)
    expect(call?.[2]).not.toBe('1970-01-01T00:03:20.000Z')
    expect(Math.abs(Date.parse(call?.[2] as string) - Date.now())).toBeLessThan(5000)
  })
})

describe('open files', () => {
  it('lands what a file owes at fd_sync, before its close', () => {
    const handle = file()
    const [wasi, fd] = opened(handle)
    expect(wasi.fd_sync(fd)).toBe(OK)
    expect(wasi.fd_close(fd)).toBe(OK)
    expect(handle.calls).toEqual(['land', 'close'])
  })

  it('reports a landing the mount cannot take as the run ends', () => {
    const [wasi] = opened(file(new Error('no space')))
    expect(wasi.closeAll()).toEqual(['/d/f.txt: no space'])
  })

  it('refuses a seek and a tell on the standard streams', () => {
    const [wasi] = opened(file())
    expect(wasi.fd_seek(1, 0n, 0, OUT)).toBe(ESPIPE)
    expect(wasi.fd_tell(0, OUT)).toBe(ESPIPE)
    expect(wasi.fd_seek(99, 0n, 0, OUT)).toBe(EBADF)
  })
})

describe('paths', () => {
  it('refuses a .. that climbs out of a file', () => {
    const wasi = guest(view())
    const length = put(wasi, PATH, 'd/f.txt/../f.txt')
    const call = wasiImports(wasi).wasi_snapshot_preview1 as unknown as {
      path_filestat_get: (...args: number[]) => number
    }
    expect(call.path_filestat_get(3, 1, PATH, length, OUT)).toBe(ENOTDIR)
  })

  it('lists a directory in records a cookie resumes', () => {
    const wasi = guest(view())
    const length = put(wasi, PATH, 'd')
    expect(wasi.path_open(3, 1, PATH, length, 2, 0n, 0n, 0, OUT)).toBe(OK)
    const fd = u32(wasi, OUT)
    expect(wasi.fd_readdir(fd, 4096, 1024, 1n, OUT)).toBe(OK)
    expect(u32(wasi, OUT)).toBe(24 + 3)
    expect(new TextDecoder().decode(new Uint8Array(wasi.memory.buffer, 4096 + 24, 3))).toBe('sub')
  })
})

describe('streams', () => {
  it('fails a write whose reader went away with EPIPE', () => {
    const wasi = guest(view(), { output: () => false })
    const view32 = new DataView(wasi.memory.buffer)
    view32.setUint32(OUT, PATH, true)
    view32.setUint32(OUT + 4, put(wasi, PATH, 'hi'), true)
    expect(wasi.fd_write(1, OUT, 1, OUT + 64)).toBe(EPIPE)
  })

  it('holds the guest for a clock subscription, and ends it when the run stops', () => {
    const waited: number[] = []
    const wasi = guest(view(), {
      wait: (ms) => {
        waited.push(ms)
        return waited.length > 1
      },
    })
    const sub = new DataView(wasi.memory.buffer, 512, 48)
    sub.setUint8(8, 0)
    sub.setUint32(16, 1, true)
    sub.setBigUint64(24, 50_000_000n, true)
    expect(wasi.poll_oneoff(512, 4096, 1, OUT)).toBe(OK)
    expect(waited[0]).toBeGreaterThan(40)
    expect(() => wasi.poll_oneoff(512, 4096, 1, OUT)).toThrow(GuestExit)
    expect(wasi.exitCode).toBe(130)
  })
})
