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
import { RuntimeFiles } from '../../files.ts'
import { MontyFs } from './index.ts'
import type { GuestStat } from './stat.ts'
import { PrefixResolver } from '../../resolver.ts'
import { MAX_URANDOM_BYTES } from './constants.ts'

const NOT_HANDLED = Symbol('NOT_HANDLED')

// Stands in for the engine's MontyFileHandle: the adapter only needs a
// constructible class whose instances it can hand back from `open`.
class FakeHandle {
  constructor(
    readonly path: string,
    readonly mode: string,
  ) {}
}

// Stands in for the engine's ClassInstance wrapper, which carries a
// host object into the guest as a class instance rather than a dict.
// The fake keeps the wrapped object reachable so a test can read the
// stat fields the real wrapper would send.
class FakeClassInstance {
  constructor(
    readonly instance: object,
    readonly options?: { name?: string; eagerAttrs?: readonly string[] | 'all' },
  ) {}
}

const BITS = { NOT_HANDLED, MontyFileHandle: FakeHandle, ClassInstance: FakeClassInstance }

function accessOn(
  dispatch: BridgeDispatchFn,
  env: Record<string, string> = {},
  mounts: string[] = ['/ram'],
  links: string[] = [],
): MontyFs {
  return new MontyFs(
    BITS,
    env,
    new RuntimeFiles(
      dispatch,
      new PrefixResolver(
        () => mounts,
        () => new Set(links),
      ),
    ),
  )
}

// The file adapter builds each row from a name plus one stat, so a double
// standing in for the bridge answers both; a name it did not list stats
// as a missing path.
function listing(
  names: string[],
  dirs: string[] = [],
  links: string[] = [],
): Mock<BridgeDispatchFn> {
  return vi.fn<BridgeDispatchFn>((op, path) => {
    // A real backend answers a target or refuses with EINVAL for a
    // path that is not a link; undefined is neither.
    if (op === 'readlink') {
      if (!links.includes(path)) {
        return Promise.reject(
          Object.assign(new Error(`not a symbolic link: ${path}`), { code: 'EINVAL' }),
        )
      }
      return Promise.resolve(path + '.target')
    }
    if (op === 'readdir') {
      // A real mount refuses to list a path it does not have, and the
      // file adapter asks with a trailing slash. Answering every path would
      // make any probe built on a listing read as "yes, a directory".
      const under = names.filter((n) => n.startsWith(path))
      if (under.length === 0 && !dirs.includes(path.replace(/\/$/, ''))) {
        return Promise.reject(Object.assign(new Error(`gone: ${path}`), { code: 'ENOENT' }))
      }
      return Promise.resolve(under)
    }
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

// A backend that answers nothing: every op is refused with EACCES,
// which is not an absence and must not read as one.
function refusing(): Mock<BridgeDispatchFn> {
  return vi.fn<BridgeDispatchFn>((_op, path) =>
    Promise.reject(Object.assign(new Error(`denied: ${path}`), { code: 'EACCES' })),
  )
}

// A bridge with nothing behind it. A listing and a stat still have to
// REFUSE rather than answer undefined: the real dispatcher returns a
// row or rejects with a coded error, and an adapter that reads a broken
// answer as an empty directory would hide the break.
const noop = vi.fn<BridgeDispatchFn>((op, path) =>
  op === 'readdir' || op === 'stat'
    ? Promise.reject(Object.assign(new Error(`gone: ${path}`), { code: 'ENOENT' }))
    : Promise.resolve(undefined),
)

describe('MontyFs environment', () => {
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

  it('answers the environment entry points even with no workspace attached', () => {
    const access = new MontyFs(BITS, { A: '1' }, null)
    expect(access.handle('os.getenv', ['A'])).toBe('1')
    // With no workspace every path is out of view and refused with a
    // typed FileNotFoundError; declining instead raised PermissionError
    // where python raises this.
    expect(() => access.handle('Path.read_text', ['/tmp/x'])).toThrow('No such file or directory')
  })
})

describe('MontyFs entropy', () => {
  it('fills large requests in Web Crypto chunks and supports empty requests', () => {
    const access = new MontyFs(BITS, {}, null)
    const random = vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation((array) => {
      if (!(array instanceof Uint8Array)) throw new TypeError('expected bytes')
      expect(array.length).toBeLessThanOrEqual(65_536)
      array.fill(42)
      return array
    })
    try {
      expect(access.handle('os.urandom', [0])).toEqual(new Uint8Array())
      expect(random).not.toHaveBeenCalled()
      const bytes = access.handle('os.urandom', [65_537]) as Uint8Array
      expect(bytes.length).toBe(65_537)
      expect(bytes.every((byte) => byte === 42)).toBe(true)
      expect(random).toHaveBeenCalledTimes(2)
      const maximum = access.handle('os.urandom', [MAX_URANDOM_BYTES]) as Uint8Array
      expect(maximum.length).toBe(MAX_URANDOM_BYTES)
      expect(maximum.every((byte) => byte === 42)).toBe(true)
      expect(random).toHaveBeenCalledTimes(18)
    } finally {
      random.mockRestore()
    }
  })

  it('rejects requests above the Python cap before requesting entropy', () => {
    const access = new MontyFs(BITS, {}, null)
    const random = vi.spyOn(globalThis.crypto, 'getRandomValues')
    try {
      expect(() => access.handle('os.urandom', [MAX_URANDOM_BYTES + 1])).toThrow(
        expect.objectContaining({
          name: 'MemoryError',
          message: 'os.urandom() size exceeds max_urandom_bytes (1048576)',
        }),
      )
      expect(random).not.toHaveBeenCalled()
    } finally {
      random.mockRestore()
    }
  })
})

// The only filesystem a guest sees is the workspace's: a path outside
// the runtime's view is refused, never kept aside in a scratch tree.
describe('MontyFs outside the view', () => {
  it('answers the probes false and refuses content without reaching the bridge', async () => {
    const seen: string[] = []
    const bridge = vi.fn<BridgeDispatchFn>((op, path) => {
      seen.push(`${op} ${path}`)
      return Promise.reject(Object.assign(new Error(`gone: ${path}`), { code: 'ENOENT' }))
    })
    const access = accessOn(bridge)
    for (const probe of ['Path.exists', 'Path.is_file', 'Path.is_dir']) {
      await expect(Promise.resolve(access.handle(probe, ['/tmp/x']))).resolves.toBe(false)
    }
    for (const [name, args] of [
      ['Path.mkdir', ['/tmp']],
      ['Path.write_text', ['/tmp/x', 'hi']],
      ['Path.read_text', ['/tmp/x']],
      ['open', ['/tmp/x', 'w']],
      ['Path.stat', ['/tmp/x']],
      ['Path.iterdir', ['/tmp']],
    ] as const) {
      await expect(Promise.resolve(access.handle(name, [...args], {}))).rejects.toThrow(
        "No such file or directory: '/tmp",
      )
    }
    // Only structural questions were asked (what kind a path is, what a
    // directory holds): no bytes, no change.
    const structural = (call: string): boolean => /^(stat|readdir) /.test(call)
    expect(seen.filter((call) => !structural(call))).toEqual([])
  })

  it('refuses every path with no workspace attached', () => {
    const access = new MontyFs(BITS, {}, null)
    expect(access.handle('Path.exists', ['/ram/x'])).toBe(false)
    expect(() => access.handle('open', ['/ram/x', 'r'])).toThrow(
      '[Errno 2] No such file or directory',
    )
  })

  it('lists the root through the dispatcher, so / shows the mounts', async () => {
    const access = accessOn(listing(['/ram'], ['/ram']))
    await expect(Promise.resolve(access.handle('Path.iterdir', ['/']))).resolves.toEqual(['/ram'])
  })
})

describe('MontyFs declining', () => {
  it('declines an operation it does not implement', () => {
    expect(accessOn(noop).handle('Path.chmod', ['/ram/x'])).toBe(NOT_HANDLED)
  })

  it('a rename whose destination leaves the mount raises EXDEV', async () => {
    // The dispatcher refuses a pair on different mounts (CrossMountError);
    // half-applying the move would lose the file.
    await expect(
      Promise.resolve(accessOn(noop).handle('Path.rename', ['/ram/x', '/tmp/y'])),
    ).rejects.toThrow("[Errno 18] Invalid cross-device link: '/ram/x' -> '/tmp/y'")
  })

  it('accepts a path object as well as a string', async () => {
    const out = accessOn(noop).handle('Path.mkdir', [{ path: '/ram/d' }], {})
    expect(out).not.toBe(NOT_HANDLED)
    await out
  })
})

describe('MontyFs stat', () => {
  it("answers a mounted path from the mount's own row", async () => {
    const access = accessOn(listing(['/ram/x'], []))
    const wrapped = (await access.handle('Path.stat', ['/ram/x'])) as FakeClassInstance
    expect(wrapped).toBeInstanceOf(FakeClassInstance)
    expect(wrapped.options?.name).toBe('stat_result')
    const st = wrapped.instance as GuestStat
    expect(st.st_size).toBe(1)
    expect(st.st_mode & 0o170000).toBe(0o100000)
    expect(st.st_nlink).toBe(1)
  })

  it('reports a mounted directory the way monty does, 4096 bytes and two links', async () => {
    const access = accessOn(listing(['/ram/d'], ['/ram/d']))
    const wrapped = (await access.handle('Path.stat', ['/ram/d'])) as FakeClassInstance
    const st = wrapped.instance as GuestStat
    expect(st.st_size).toBe(4096)
    expect(st.st_mode & 0o170000).toBe(0o40000)
    expect(st.st_nlink).toBe(2)
  })

  it('raises the guest FileNotFoundError when neither half has the path', async () => {
    const access = accessOn(listing([]))
    await expect(Promise.resolve(access.handle('Path.stat', ['/ram/nope']))).rejects.toThrow(
      "[Errno 2] No such file or directory: '/ram/nope'",
    )
  })

  it('stats a directory the workspace lists although no mount claims it', async () => {
    // Only /parent/child is mounted, so /parent is a directory the
    // workspace implies: it has no row, yet exists and is_dir answer
    // True through the listing, and a stat reports a directory, as
    // python's does.
    const access = accessOn(listing(['/parent/child']), {}, ['/parent/child'])
    expect(await access.handle('Path.is_dir', ['/parent'])).toBe(true)
    const wrapped = (await access.handle('Path.stat', ['/parent'])) as FakeClassInstance
    const st = wrapped.instance as GuestStat
    expect(st.st_mode & 0o170000).toBe(0o40000)
    expect(st.st_nlink).toBe(2)
  })

  it('raises a refused listing rather than reporting the path absent', async () => {
    // A backend that will not answer has said nothing about whether
    // the path is there, so every predicate built on the listing has
    // to carry the refusal out. Reading it as "not a directory" turned
    // an authorization or transport failure into a missing file, which
    // is the one answer a guest cannot tell from the truth.
    const access = accessOn(refusing(), {}, ['/parent/child'])
    await expect(Promise.resolve(access.handle('Path.stat', ['/parent']))).rejects.toThrow(
      '[Errno 13] Permission denied',
    )
    await expect(Promise.resolve(access.handle('Path.is_dir', ['/parent']))).rejects.toThrow(
      '[Errno 13] Permission denied',
    )
    await expect(Promise.resolve(access.handle('Path.exists', ['/parent']))).rejects.toThrow(
      '[Errno 13] Permission denied',
    )
  })

  it('raises a refused listing under a mount too, on the same rule', async () => {
    const access = accessOn(refusing())
    await expect(Promise.resolve(access.handle('Path.is_dir', ['/ram/x']))).rejects.toThrow(
      '[Errno 13] Permission denied',
    )
    await expect(Promise.resolve(access.handle('Path.exists', ['/ram/x']))).rejects.toThrow(
      '[Errno 13] Permission denied',
    )
    await expect(Promise.resolve(access.handle('Path.iterdir', ['/ram/x']))).rejects.toThrow(
      '[Errno 13] Permission denied',
    )
  })

  it('answers the predicates from the row when the mount will not list', async () => {
    // A backend may serve a stat for a path it refuses to list, and
    // the row is the better answer anyway: it says what the path IS,
    // where a listing only says whether it opens. Asking the listing
    // first turned a served stat into a refusal for is_dir and into a
    // miss for is_file, neither of which the python adapter reports.
    const statOnly = vi.fn<BridgeDispatchFn>((op, path) => {
      if (op === 'stat' && (path === '/ram/d' || path === '/ram/d/f.txt')) {
        return Promise.resolve(
          new FileStat({
            name: path,
            size: 3,
            type: path === '/ram/d' ? FileType.DIRECTORY : FileType.FILE,
          }),
        )
      }
      return Promise.reject(Object.assign(new Error(`denied: ${path}`), { code: 'EACCES' }))
    })
    const access = accessOn(statOnly)
    await expect(Promise.resolve(access.handle('Path.is_dir', ['/ram/d']))).resolves.toBe(true)
    await expect(Promise.resolve(access.handle('Path.is_file', ['/ram/d']))).resolves.toBe(false)
    await expect(Promise.resolve(access.handle('Path.exists', ['/ram/d']))).resolves.toBe(true)
    await expect(Promise.resolve(access.handle('Path.is_file', ['/ram/d/f.txt']))).resolves.toBe(
      true,
    )
    await expect(Promise.resolve(access.handle('Path.is_dir', ['/ram/d/f.txt']))).resolves.toBe(
      false,
    )
    expect(statOnly.mock.calls.filter(([op]) => op === 'readdir')).toHaveLength(0)
  })
})

describe('MontyFs clock and lexical entry points', () => {
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

describe('MontyFs mounted open and append', () => {
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

  // RAM lists a directory as a bare name, and the listing no longer
  // stats it, so the kind has to come from the path's own stat.
  it('refuses to open a mounted directory listed without a slash', async () => {
    const access = accessOn(listing(['/ram/d', '/ram/d/a.txt'], ['/ram/d']))
    await expect(Promise.resolve(access.handle('open', ['/ram/d', 'r']))).rejects.toThrow(
      '[Errno 21] Is a directory',
    )
  })

  it('mkdir under exist_ok accepts a mounted directory listed without a slash', async () => {
    const access = accessOn(listing(['/ram/d', '/ram/d/a.txt'], ['/ram/d']))
    expect(await access.handle('Path.mkdir', ['/ram/d'], { exist_ok: true })).toBeNull()
  })

  // The follow-stat of a dangling link misses, but the listed name is
  // still there: O_EXCL refuses it rather than creating through it, and a
  // read follows the link, so it fails at open, as POSIX and python's
  // monty answer, rather than handing back a handle whose first read
  // fails.
  it.each([
    ['an exclusive', 'x', '[Errno 17] File exists'],
    ['a read', 'r', '[Errno 2] No such file or directory'],
  ])('refuses %s open of a dangling link it listed', async (_name, mode, refusal) => {
    const dispatch = vi.fn<BridgeDispatchFn>((op, path, _bytes, _dst, attrs) => {
      if (op === 'readdir' && path === '/ram/') return Promise.resolve(['/ram/lnk'])
      if (op === 'stat' && path === '/ram/lnk' && attrs?.nofollow === true) {
        return Promise.resolve(new FileStat({ name: path, size: 8, type: FileType.SYMLINK }))
      }
      return Promise.reject(Object.assign(new Error(`gone: ${path}`), { code: 'ENOENT' }))
    })
    const access = accessOn(dispatch, {}, ['/ram'], ['lnk'])
    await expect(Promise.resolve(access.handle('open', ['/ram/lnk', mode]))).rejects.toThrow(
      refusal,
    )
    expect(dispatch.mock.calls.some(([op]) => op === 'create')).toBe(false)
  })

  it('mkdir on an existing file raises FileExistsError even under exist_ok', async () => {
    const dispatch = listing(['/ram/a.txt'])
    const access = accessOn(dispatch)
    await expect(
      Promise.resolve(access.handle('Path.mkdir', ['/ram/a.txt'], { exist_ok: true })),
    ).rejects.toThrow('[Errno 17] File exists')
  })
})

describe('MontyFs path operations', () => {
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
  it('answers is_symlink from the name plane, through readlink', async () => {
    const dispatch = listing(['/ram/d/l', '/ram/d/f'], [], ['/ram/d/l'])
    const access = accessOn(dispatch, {}, ['/ram'], ['l'])
    expect(await access.handle('Path.is_symlink', ['/ram/d/l'])).toBe(true)
    expect(await access.handle('Path.is_symlink', ['/ram/d/f'])).toBe(false)
  })

  it('still sees a dangling link after the guest asked exists() first', async () => {
    // `exists()` stats, the stat follows the link and misses, and the
    // path is remembered as absent. Reading the mark off the parent
    // listing went through that cache, so `is_symlink()` answered
    // False for a link plainly there. python asks readlink, which
    // never consulted the cache, so only this host diverged.
    const dispatch = listing([], [], ['/ram/d/dangling'])
    const access = accessOn(dispatch, {}, ['/ram'], ['dangling'])
    expect(await access.handle('Path.exists', ['/ram/d/dangling'])).toBe(false)
    expect(await access.handle('Path.is_symlink', ['/ram/d/dangling'])).toBe(true)
  })
})
