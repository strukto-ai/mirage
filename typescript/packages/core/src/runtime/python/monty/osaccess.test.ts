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

import { describe, expect, it, vi, type Mock } from 'vitest'
import type { BridgeDispatchFn } from '../../types.ts'
import { ContentType, FileStat, FileType } from '../../../types.ts'
import { RuntimeVFS } from '../../vfs.ts'
import { MirageOSAccess } from './index.ts'
import { MontyVFS } from './vfs.ts'
import { PrefixResolver } from '../../resolver.ts'

const NOT_HANDLED = Symbol('NOT_HANDLED')

// Stands in for the binding's MontyFileHandle: the door only needs a
// constructible class whose instances it can hand back from `open`.
class FakeHandle {
  constructor(
    readonly path: string,
    readonly mode: string,
  ) {}
}

const BITS = { NOT_HANDLED, MontyFileHandle: FakeHandle }

function accessOn(
  dispatch: BridgeDispatchFn,
  env: Record<string, string> = {},
  mounts: string[] = ['/ram'],
  links: string[] = [],
): MirageOSAccess {
  return new MirageOSAccess(
    BITS,
    env,
    new MontyVFS(
      new RuntimeVFS(
        dispatch,
        new PrefixResolver(
          () => mounts,
          () => new Set(links),
        ),
      ),
    ),
  )
}

// The door builds each row from a name plus one stat, so a double
// standing in for the bridge answers both; a name it did not list stats
// as a missing path.
function listing(names: string[], dirs: string[] = []): Mock<BridgeDispatchFn> {
  return vi.fn<BridgeDispatchFn>((op, path) => {
    if (op === 'readdir') return Promise.resolve(names)
    if (op === 'stat' && names.includes(path)) {
      return Promise.resolve(
        new FileStat({
          name: path,
          size: 1,
          type: dirs.includes(path) ? FileType.DIRECTORY : FileType.FILE,
        }),
      )
    }
    return Promise.reject(Object.assign(new Error(`gone: ${path}`), { code: 'ENOENT' }))
  })
}

const noop = vi.fn<BridgeDispatchFn>(() => Promise.resolve(undefined))

describe('MirageOSAccess environment', () => {
  it('answers os.getenv from the run environment, with the caller default on a miss', () => {
    const access = accessOn(noop, { HOME: '/root' })
    expect(access.handle('os.getenv', ['HOME'])).toBe('/root')
    expect(access.handle('os.getenv', ['NOPE'])).toBeNull()
    expect(access.handle('os.getenv', ['NOPE', 'fallback'])).toBe('fallback')
  })

  it('misses on an inherited property rather than leaking a host function', () => {
    // The guest picks the key, so `toString` must not resolve.
    expect(accessOn(noop, {}).handle('os.getenv', ['toString'])).toBeNull()
  })

  it('hands os.environ a copy, so a mutating guest cannot reach the session env', () => {
    const env = { A: '1' }
    const out = accessOn(noop, env).handle('os.environ', []) as Record<string, string>
    expect(out).toEqual({ A: '1' })
    out.A = 'tampered'
    expect(env.A).toBe('1')
  })

  it('answers the environment doors even with no workspace attached', () => {
    const access = new MirageOSAccess(BITS, { A: '1' }, null)
    expect(access.handle('os.getenv', ['A'])).toBe('1')
    // A read now reaches the scratch tree, whose miss is a typed
    // FileNotFoundError — the JS binding has no tree of its own, so
    // declining raised PermissionError where python raised this.
    expect(() => access.handle('Path.read_text', ['/tmp/x'])).toThrow('No such file or directory')
  })
})

describe('MirageOSAccess scratch paths', () => {
  it('serves a path outside every mount from the scratch tree, like python', async () => {
    // The tree starts holding only '/', exactly like python's: a guest
    // makes its scratch directories before writing under them.
    const access = accessOn(noop)
    await expect(Promise.resolve(access.handle('Path.exists', ['/tmp/x']))).resolves.toBe(false)
    expect(() => access.handle('Path.write_text', ['/tmp/x', 'hi'])).toThrow(
      'No such file or directory',
    )
    access.handle('Path.mkdir', ['/tmp'], {})
    expect(access.handle('Path.write_text', ['/tmp/x', 'hi'])).toBe(2)
    expect(access.handle('Path.read_text', ['/tmp/x'])).toBe('hi')
    expect(access.handle('Path.exists', ['/tmp/x'])).toBe(true)
    expect(access.handle('Path.is_file', ['/tmp/x'])).toBe(true)
  })

  it('write_text reports code points, the way python len counts', () => {
    const access = accessOn(noop)
    access.handle('Path.mkdir', ['/tmp'], {})
    expect(access.handle('Path.write_text', ['/tmp/g.txt', '\u{1d11e}'])).toBe(1)
  })

  it('opens a scratch file and answers the handle follow-ups from the tree', () => {
    const access = accessOn(noop)
    access.handle('Path.mkdir', ['/tmp'], {})
    const handle = access.handle('open', ['/tmp/log.txt', 'w']) as FakeHandle
    expect(handle).toBeInstanceOf(FakeHandle)
    expect(handle.mode).toBe('w')
    expect(access.handle('Path.append_text', ['/tmp/log.txt', 'abc'])).toBe(3)
    expect(access.handle('Path.read_text', ['/tmp/log.txt'])).toBe('abc')
  })

  it("open 'r' on a missing scratch file raises python's own FileNotFoundError", () => {
    expect(() => accessOn(noop).handle('open', ['/tmp/nope', 'r'])).toThrow(
      "[Errno 2] No such file or directory: '/tmp/nope'",
    )
  })

  it('mkdir honors parents and exist_ok in the tree', () => {
    const access = accessOn(noop)
    expect(() => access.handle('Path.mkdir', ['/tmp/a/b'], {})).toThrow('No such file or directory')
    expect(access.handle('Path.mkdir', ['/tmp/a/b'], { parents: true, exist_ok: false })).toBeNull()
    expect(() => access.handle('Path.mkdir', ['/tmp/a/b'], {})).toThrow('File exists')
    expect(access.handle('Path.mkdir', ['/tmp/a/b'], { parents: false, exist_ok: true })).toBeNull()
  })

  it('a rename crossing into a mount raises EXDEV, as a cross-filesystem move', () => {
    const access = accessOn(noop)
    access.handle('Path.mkdir', ['/tmp'], {})
    access.handle('Path.write_text', ['/tmp/x', 'hi'])
    expect(() => access.handle('Path.rename', ['/tmp/x', '/ram/y'])).toThrow(
      '[Errno 18] Invalid cross-device link',
    )
  })

  it('merges the workspace listing into a scratch iterdir, so / shows the mounts', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>((op, path) => {
      if (op === 'readdir' && path === '/') return Promise.resolve(['/ram/'])
      return Promise.reject(Object.assign(new Error(`gone: ${path}`), { code: 'ENOENT' }))
    })
    const access = accessOn(dispatch)
    access.handle('Path.mkdir', ['/tmp'], {})
    expect(await access.handle('Path.iterdir', ['/'])).toEqual(['/ram', '/tmp'])
  })

  it('answers is_symlink false for a scratch path, whose tree holds no links', async () => {
    const access = accessOn(vi.fn<BridgeDispatchFn>(() => Promise.resolve(undefined)))
    expect(await access.handle('Path.is_symlink', ['/tmp/l'])).toBe(false)
  })
})

describe('MirageOSAccess declining', () => {
  it('declines an operation it does not implement', () => {
    expect(accessOn(noop).handle('Path.chmod', ['/ram/x'])).toBe(NOT_HANDLED)
  })

  it('declines Path.stat, which the JS binding cannot carry to the guest', () => {
    // Probed on 0.0.21: a stat answer arrives as a guest dict (or
    // list), so st.st_size raises AttributeError; python's binding
    // takes a real StatResult. Upstream gap, not a policy choice.
    expect(accessOn(noop).handle('Path.stat', ['/ram/x'])).toBe(NOT_HANDLED)
    expect(accessOn(noop).handle('Path.stat', ['/tmp/x'])).toBe(NOT_HANDLED)
  })

  it('a rename whose destination leaves the workspace raises EXDEV', () => {
    // python routes it to the dispatcher, whose resolver answers
    // CrossMountError; half-applying the move would lose the file.
    expect(() => accessOn(noop).handle('Path.rename', ['/ram/x', '/tmp/y'])).toThrow(
      '[Errno 18] Invalid cross-device link',
    )
  })

  it('accepts a path object as well as a string', () => {
    expect(accessOn(noop).handle('Path.mkdir', [{ path: '/ram/d' }], {})).not.toBe(NOT_HANDLED)
  })
})

describe('MirageOSAccess clock and lexical doors', () => {
  it('serves datetime.now from the host clock as a DateTime marker', () => {
    const naive = accessOn(noop).handle('datetime.now', [null]) as Record<string, unknown>
    expect(naive.__monty_type__).toBe('DateTime')
    expect(naive.year).toBeGreaterThanOrEqual(2026)
    expect(naive.offsetSeconds).toBeUndefined()
  })

  it('answers an aware datetime.now in the asked timezone', () => {
    const marker = { __monty_type__: 'TimeZone', offsetSeconds: 0, name: 'UTC' }
    const aware = accessOn(noop).handle('datetime.now', [marker]) as Record<string, unknown>
    expect(aware.offsetSeconds).toBe(0)
    expect(aware.timezoneName).toBe('UTC')
  })

  it('serves date.today as a Date marker', () => {
    const today = accessOn(noop).handle('date.today', []) as Record<string, unknown>
    expect(today.__monty_type__).toBe('Date')
    expect(today.year).toBeGreaterThanOrEqual(2026)
  })

  it('resolves lexically for any path, a str like python answers', () => {
    const access = accessOn(noop)
    expect(access.handle('Path.resolve', ['rel/x.txt'])).toBe('/rel/x.txt')
    expect(access.handle('Path.absolute', ['/abs/y.txt'])).toBe('/abs/y.txt')
  })
})

describe('MirageOSAccess mounted open and append', () => {
  function establishing(seed: string[]): {
    dispatch: Mock<BridgeDispatchFn>
    created: string[]
    truncated: string[]
    appended: Uint8Array[]
  } {
    const created: string[] = []
    const truncated: string[] = []
    const appended: Uint8Array[] = []
    const dispatch = vi.fn<BridgeDispatchFn>((op, path, bytes) => {
      if (op === 'readdir') {
        // Only the mount directory lists; probing a file path (the
        // is-it-a-directory check) misses like a real mount.
        if (path !== '/ram/') {
          return Promise.reject(Object.assign(new Error(`gone: ${path}`), { code: 'ENOENT' }))
        }
        return Promise.resolve(seed)
      }
      if (op === 'stat' && seed.includes(path)) {
        return Promise.resolve(
          new FileStat({ name: path, size: 1, type: FileType.FILE, content: ContentType.TEXT }),
        )
      }
      if (op === 'read' && seed.includes(path)) {
        return Promise.resolve(new TextEncoder().encode('base-'))
      }
      if (op === 'create') {
        created.push(path)
        return Promise.resolve(undefined)
      }
      if (op === 'truncate') {
        truncated.push(path)
        return Promise.resolve(undefined)
      }
      if (op === 'append') {
        appended.push(bytes ?? new Uint8Array())
        return Promise.resolve(undefined)
      }
      return Promise.reject(Object.assign(new Error(`gone: ${path}`), { code: 'ENOENT' }))
    })
    return { dispatch, created, truncated, appended }
  }

  it("open 'w' truncates what exists and creates what does not, at open time", async () => {
    const { dispatch, created, truncated } = establishing(['/ram/keep.txt'])
    const access = accessOn(dispatch)
    expect(await access.handle('open', ['/ram/keep.txt', 'w'])).toBeInstanceOf(FakeHandle)
    expect(await access.handle('open', ['/ram/new.txt', 'w'])).toBeInstanceOf(FakeHandle)
    expect(truncated).toEqual(['/ram/keep.txt'])
    expect(created).toEqual(['/ram/new.txt'])
  })

  it("open 'a' creates only what is missing and establishes the append base", async () => {
    const { dispatch, created, appended } = establishing(['/ram/log.txt'])
    const access = accessOn(dispatch)
    await access.handle('open', ['/ram/log.txt', 'a'])
    expect(created).toEqual([])
    await access.handle('Path.append_text', ['/ram/log.txt', 'x'])
    await access.handle('Path.append_text', ['/ram/log.txt', 'y'])
    // Deltas alone ride the append op; the running whole only backs
    // the no-append-op write fallback.
    expect(appended.map((b) => new TextDecoder().decode(b))).toEqual(['x', 'y'])
  })

  it("open 'r' establishes nothing and misses loudly", async () => {
    const { dispatch, created, truncated } = establishing(['/ram/a.txt'])
    const access = accessOn(dispatch)
    await access.handle('open', ['/ram/a.txt', 'r'])
    expect(created).toEqual([])
    expect(truncated).toEqual([])
    await expect(Promise.resolve(access.handle('open', ['/ram/missing.txt', 'r']))).rejects.toThrow(
      '[Errno 2] No such file or directory',
    )
  })

  it('mkdir forwards parents to the bridge and answers exist_ok locally', async () => {
    const calls: [string, unknown][] = []
    const dispatch = vi.fn<BridgeDispatchFn>((op, path, _bytes, _dst, attrs) => {
      if (op === 'mkdir') {
        calls.push([path, attrs])
        return Promise.resolve(undefined)
      }
      return Promise.reject(Object.assign(new Error(`gone: ${path}`), { code: 'ENOENT' }))
    })
    const access = accessOn(dispatch)
    await access.handle('Path.mkdir', ['/ram/x/y'], { parents: true, exist_ok: false })
    expect(calls).toEqual([['/ram/x/y', { parents: true }]])
  })

  it('mkdir on an existing file raises FileExistsError even under exist_ok', async () => {
    const dispatch = listing(['/ram/a.txt'])
    const access = accessOn(dispatch)
    await expect(
      Promise.resolve(access.handle('Path.mkdir', ['/ram/a.txt'], { exist_ok: true })),
    ).rejects.toThrow('[Errno 17] File exists')
  })
})

describe('MirageOSAccess path operations', () => {
  it('decodes read_text and leaves read_bytes raw', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>(() => Promise.resolve(new TextEncoder().encode('hi')))
    const access = accessOn(dispatch)
    expect(await access.handle('Path.read_text', ['/ram/x'])).toBe('hi')
    expect(await access.handle('Path.read_bytes', ['/ram/x'])).toEqual(
      new TextEncoder().encode('hi'),
    )
  })

  it('iterdir yields the entry paths', async () => {
    const dispatch = listing(['/ram/d/a', '/ram/d/sub'], ['/ram/d/sub'])
    expect(await accessOn(dispatch).handle('Path.iterdir', ['/ram/d'])).toEqual([
      '/ram/d/a',
      '/ram/d/sub',
    ])
  })

  it('answers the exists family as booleans, never as a rejection', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>((op, path) => {
      if (op === 'readdir' && path === '/ram/d/') return Promise.resolve(['/ram/d/a'])
      if (op === 'stat' && path === '/ram/d/a') {
        return Promise.resolve(
          new FileStat({ name: path, size: 1, type: FileType.FILE, content: ContentType.TEXT }),
        )
      }
      return Promise.reject(Object.assign(new Error('gone'), { code: 'ENOENT' }))
    })
    const access = accessOn(dispatch)
    expect(await access.handle('Path.is_dir', ['/ram/d'])).toBe(true)
    expect(await access.handle('Path.is_file', ['/ram/d/a'])).toBe(true)
    expect(await access.handle('Path.exists', ['/ram/d/a'])).toBe(true)
    expect(await access.handle('Path.is_file', ['/ram/d/nope'])).toBe(false)
    expect(await access.handle('Path.exists', ['/ram/nope/deep'])).toBe(false)
  })

  it('does not classify a character device as a regular file', async () => {
    const dispatch = vi.fn<BridgeDispatchFn>((op, path) => {
      if (op === 'readdir' && path === '/dev/') return Promise.resolve(['/dev/null'])
      if (op === 'stat' && path === '/dev/null') {
        return Promise.resolve(new FileStat({ name: 'null', type: FileType.CHAR_DEVICE }))
      }
      return Promise.reject(Object.assign(new Error('gone'), { code: 'ENOENT' }))
    })
    const access = accessOn(dispatch, {}, ['/dev'])
    expect(await access.handle('Path.exists', ['/dev/null'])).toBe(true)
    expect(await access.handle('Path.is_file', ['/dev/null'])).toBe(false)
  })

  // Monty's own tree holds no links, so declining this verb answered
  // False for a link the shell made.
  it('answers is_symlink from the parent listing mark', async () => {
    const dispatch = listing(['/ram/d/l', '/ram/d/f'])
    const access = accessOn(dispatch, {}, ['/ram'], ['l'])
    expect(await access.handle('Path.is_symlink', ['/ram/d/l'])).toBe(true)
    expect(await access.handle('Path.is_symlink', ['/ram/d/f'])).toBe(false)
  })
})
