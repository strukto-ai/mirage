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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeGitHub, blobSha } from '../../core/github/_test_util.ts'
import { DEFAULT_READ_TTL, MountMode, ReadPolicy } from '../../types.ts'
import type { VFS } from '../base.ts'
import { RAMVFS } from '../ram/ram.ts'
import { getTestParser } from '../../workspace/fixtures/workspace_fixture.ts'
import { Mount } from '../../workspace/mount/spec.ts'
import { ContentDriftError } from '../../workspace/snapshot/drift.ts'
import { toStateDict } from '../../workspace/snapshot/state.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { GitHubVFS } from './github.ts'

const DEC = new TextDecoder()
const OLD = 'version one\n'
const NEW = 'version two, longer\n'
const PATH = '/gh/docs/a.txt'

let gh: FakeGitHub

beforeEach(() => {
  gh = new FakeGitHub({ 'docs/a.txt': OLD, 'docs/b.txt': 'bravo', 'top.txt': 'top' })
  vi.stubGlobal('fetch', gh.fetch)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// create fetches the repository and its whole tree; the ledgers count what
// happens after that.
async function vfsOf(): Promise<GitHubVFS> {
  const vfs = await GitHubVFS.create({
    token: 't',
    owner: 'o',
    repo: 'r',
    ref: 'main',
    baseUrl: gh.url,
  })
  gh.log.length = 0
  return vfs
}

async function ws(
  vfs: VFS,
  policy: ReadPolicy = ReadPolicy.FRESH,
  prefix = '/gh',
): Promise<Workspace> {
  return new Workspace(
    {
      [prefix]: new Mount(vfs, { mode: MountMode.READ, read: { policy, ttl: DEFAULT_READ_TTL } }),
      '/r': [new RAMVFS(), MountMode.WRITE],
    },
    { shellParser: await getTestParser() },
  )
}

async function out(w: Workspace, line: string): Promise<string> {
  const result = await w.shell(line)
  expect([result.exitCode, DEC.decode(result.stderr)], line).toEqual([0, ''])
  return DEC.decode(result.stdout)
}

async function fails(w: Workspace, line: string): Promise<string> {
  const result = await w.shell(line)
  expect(result.exitCode, line).toBe(1)
  return DEC.decode(result.stderr)
}

describe('github under read: fresh', () => {
  // A mount at /src over a repository holding a src/ directory is the decoy:
  // a record labelled repo-relative or mount-relative lands on a key the
  // cache never asks for, so the entry would carry no token.
  for (const prefix of ['/', '/gh', '/src']) {
    it(`leaves the read's sha on the cache entry (${prefix})`, async () => {
      gh.files.clear()
      gh.set('src/a.txt', OLD)
      const w = await ws(await vfsOf(), ReadPolicy.FRESH, prefix)
      const path = `${prefix === '/' ? '' : prefix}/src/a.txt`
      try {
        expect(await out(w, `cat ${path}`)).toBe(OLD)
        expect(await w.cache.isFresh(path, await blobSha(OLD))).toBe(true)
      } finally {
        await w.close()
      }
    })
  }

  // Each cell is [dir listings, whole-tree walks, blob downloads] for one line
  // on a warm fresh mount: cat pays two probes (routing, then the cache
  // door), as hf's table does; cp skips routing's probe.
  const WARM: [string, [number, number, number]][] = [
    [`cat ${PATH}`, [2, 0, 0]],
    [`cat ${PATH} | head -c 1`, [2, 0, 0]],
    [`cp ${PATH} /r/a.txt`, [1, 0, 0]],
  ]
  for (const [line, cost] of WARM) {
    it(`costs one listing per probe: ${line}`, async () => {
      const w = await ws(await vfsOf())
      try {
        await out(w, `cat ${PATH}`)
        gh.log.length = 0
        await out(w, line)
        expect(gh.counts()).toEqual(cost)
      } finally {
        await w.close()
      }
    })
  }

  it('refetches a changed file once, then serves it warm', async () => {
    const w = await ws(await vfsOf())
    try {
      expect(await out(w, `cat ${PATH}`)).toBe(OLD)
      gh.set('docs/a.txt', NEW)
      gh.log.length = 0
      expect(await out(w, `cat ${PATH}`)).toBe(NEW)
      // The probe finds a new sha; cat's own stat asks the cleared index's one
      // directory; the read refills and downloads.
      expect(gh.counts()).toEqual([2, 1, 1])
      gh.log.length = 0
      expect(await out(w, `cat ${PATH}`)).toBe(NEW)
      expect(gh.counts()).toEqual([2, 0, 0])
    } finally {
      await w.close()
    }
  })

  it('serves the cache on a bounded mount', async () => {
    const w = await ws(await vfsOf(), ReadPolicy.BOUNDED)
    try {
      expect(await out(w, `cat ${PATH}`)).toBe(OLD)
      gh.set('docs/a.txt', NEW)
      gh.log.length = 0
      expect(await out(w, `cat ${PATH}`)).toBe(OLD)
      expect(gh.counts()).toEqual([0, 0, 0])
    } finally {
      await w.close()
    }
  })

  it('lists a new mount once and never asks one directory', async () => {
    const w = await ws(await vfsOf())
    try {
      await out(w, `stat ${PATH}`)
      await out(w, `stat ${PATH}`)
      await out(w, 'ls /gh/docs')
      // create fetched the tree but seeded no index, so the first stat walks.
      expect(gh.counts()).toEqual([0, 1, 0])
    } finally {
      await w.close()
    }
  })

  it('reads a revert through both doors', async () => {
    // Content-addressed shas make every stamp source agree once the index is
    // refilled, so this guards that both the stream door (cat) and the bytes
    // door (cp) stamp, rather than telling stamp sources apart.
    const w = await ws(await vfsOf())
    try {
      for (const [step, data] of [OLD, NEW, OLD].entries()) {
        gh.set('docs/a.txt', data)
        expect(await out(w, `cat ${PATH}`)).toBe(data)
        await out(w, `cp ${PATH} /r/c${String(step)}`)
        expect(await out(w, `cat /r/c${String(step)}`)).toBe(data)
        const sha = await blobSha(data)
        expect(await w.cache.isFresh(PATH, sha)).toBe(true)
        expect(gh.log).toContainEqual(['blob', sha])
      }
    } finally {
      await w.close()
    }
  })

  it('serves the listing on a cold read until a probe corrects it', async () => {
    // Documented limit, chosen by the user: fresh revalidates cached bytes, so
    // the first read of a file comes from the mount's listing, and the next
    // read's probe corrects it.
    const w = await ws(await vfsOf())
    try {
      await out(w, 'ls /gh/docs')
      gh.set('docs/a.txt', NEW)
      expect(await out(w, `cat ${PATH}`)).toBe(OLD)
      expect(await w.cache.isFresh(PATH, await blobSha(OLD))).toBe(true)
      expect(await out(w, `cat ${PATH}`)).toBe(NEW)
    } finally {
      await w.close()
    }
  })

  it('leaves find its whole listing after a probe', async () => {
    const w = await ws(await vfsOf())
    try {
      await out(w, `cat ${PATH}`)
      await out(w, `cat ${PATH}`)
      const walks = gh.count('recursive')
      const listed = await out(w, 'find /gh -type f')
      expect(listed.split('\n').filter(Boolean).sort()).toEqual([
        '/gh/docs/a.txt',
        '/gh/docs/b.txt',
        '/gh/top.txt',
      ])
      expect(gh.count('recursive')).toBe(walks)
    } finally {
      await w.close()
    }
  })
})

describe('github cannot-see versus gone', () => {
  async function overlaid(w: Workspace): Promise<void> {
    await w.namespace.setAttrs(PATH, { mode: 0o600 })
  }

  function kept(w: Workspace): boolean {
    return w.namespace.metaFor(PATH)?.mode === 0o600
  }

  it('keeps the overlay for a repository it cannot see', async () => {
    const w = await ws(await vfsOf())
    try {
      await out(w, `cat ${PATH}`)
      await overlaid(w)
      // Lost access answers 404 on both endpoints: cannot verify, so the copy
      // is dropped and the cold read fails, but nothing is gone.
      gh.fail.set('dir', [404, 'Not Found'])
      gh.fail.set('recursive', [404, 'Not Found'])
      // GitHub's own message, as any refused github read prints it; python
      // prints aiohttp's rendering of the same 404. Never ENOENT.
      expect(await fails(w, `cat ${PATH}`)).toBe('cat: Not Found\n')
      expect(kept(w)).toBe(true)
      await fails(w, `cp ${PATH} /r/x`)
      expect(kept(w)).toBe(true)
    } finally {
      await w.close()
    }
  })

  it('keeps the overlay for a refused token', async () => {
    const w = await ws(await vfsOf())
    try {
      await out(w, `cat ${PATH}`)
      await overlaid(w)
      gh.fail.set('dir', [401, 'Bad credentials'])
      gh.fail.set('recursive', [401, 'Bad credentials'])
      await fails(w, `cat ${PATH}`)
      expect(kept(w)).toBe(true)
    } finally {
      await w.close()
    }
  })

  it('treats a parent directory gone upstream as gone', async () => {
    const w = await ws(await vfsOf())
    try {
      await out(w, `cat ${PATH}`)
      await overlaid(w)
      gh.files.delete('docs/a.txt')
      gh.files.delete('docs/b.txt')
      expect(await fails(w, `cat ${PATH}`)).toBe(`cat: ${PATH}: No such file or directory\n`)
      expect(w.namespace.metaFor(PATH) ?? null).toBeNull()
      expect(await w.cache.exists(PATH)).toBe(false)
    } finally {
      await w.close()
    }
  })

  it('treats a file gone from a live directory as gone', async () => {
    const w = await ws(await vfsOf())
    try {
      await out(w, `cat ${PATH}`)
      await overlaid(w)
      gh.files.delete('docs/a.txt')
      gh.log.length = 0
      expect(await fails(w, `cat ${PATH}`)).toBe(`cat: ${PATH}: No such file or directory\n`)
      expect(w.namespace.metaFor(PATH) ?? null).toBeNull()
      // The probe and cat's own stat each answer absent from one listing of
      // docs/; the single walk is the generic adapter asking whether the path
      // is an implicit directory after that ENOENT. A probe that deferred on
      // the complete listing would walk once more.
      expect(gh.counts()).toEqual([2, 1, 0])
    } finally {
      await w.close()
    }
  })

  async function clearedWithOverlay(w: Workspace): Promise<void> {
    await out(w, `cat ${PATH}`)
    await w.cache.remove(PATH)
    const index = w.registry.mountFor(PATH).index
    if (index === undefined) throw new Error('the github mount has no index to clear')
    await index.clear()
    await overlaid(w)
    gh.fail.set('dir', [404, 'Not Found'])
    gh.fail.set('recursive', [401, 'Bad credentials'])
  }

  it('never reads cannot-see as gone through the dispatcher door', async () => {
    // No cached copy, so cp's own stat is the op that reaches the backend: an
    // ENOENT there goes through onOpMissing, which drops the overlay.
    const w = await ws(await vfsOf())
    try {
      await clearedWithOverlay(w)
      await fails(w, `cp ${PATH} /r/x`)
      expect(kept(w)).toBe(true)
    } finally {
      await w.close()
    }
  })

  it('never reads cannot-see as gone through the xattr door', async () => {
    const w = await ws(await vfsOf())
    try {
      await clearedWithOverlay(w)
      await fails(w, `getfattr -d ${PATH}`)
      expect(kept(w)).toBe(true)
    } finally {
      await w.close()
    }
  })

  it('does not read a truncated parent listing as absence', async () => {
    const w = await ws(await vfsOf())
    try {
      await out(w, `cat ${PATH}`)
      await overlaid(w)
      gh.truncatedDirs.set('docs', 0)
      gh.log.length = 0
      expect(await out(w, `cat ${PATH}`)).toBe(OLD)
      expect(kept(w)).toBe(true)
      expect(gh.count('recursive')).toBeGreaterThanOrEqual(1)
    } finally {
      await w.close()
    }
  })

  it('probes one directory on a truncated repository', async () => {
    gh.files.clear()
    gh.set('top.txt', 't')
    gh.set('docs/a.txt', OLD)
    gh.truncatedRecursive = true
    const vfs = await vfsOf()
    // create builds it truncated: only the per-directory walk's listings can
    // arm the point route here.
    expect(vfs.accessor.truncated).toBe(true)
    expect(vfs.accessor.refills).toBe(0)
    const w = await ws(vfs)
    try {
      expect(await out(w, `cat ${PATH}`)).toBe(OLD)
      expect(vfs.accessor.refills).toBeGreaterThan(0)
      gh.log.length = 0
      expect(await out(w, `cat ${PATH}`)).toBe(OLD)
      expect(gh.counts()).toEqual([2, 0, 0])
      expect(gh.count('sha_dir')).toBe(0)
    } finally {
      await w.close()
    }
  })
})

describe('github snapshot pins', () => {
  async function pinnedState(vfs?: VFS) {
    const w = await ws(vfs ?? (await vfsOf()))
    try {
      await out(w, `cat ${PATH}`)
      return await toStateDict(w)
    } finally {
      await w.close()
    }
  }

  async function load(state: Awaited<ReturnType<typeof toStateDict>>, vfs: VFS): Promise<string> {
    const loaded = await Workspace.fromState(
      state,
      { shellParser: await getTestParser() },
      {
        '/gh': vfs,
      },
    )
    try {
      return await out(loaded, `cat ${PATH}`)
    } finally {
      await loaded.close()
    }
  }

  it('pins the sha and a changed file drifts', async () => {
    const state = await pinnedState()
    const pins = (state.fingerprints ?? []).filter((f) => f.path === PATH)
    expect(pins.map((p) => p.fingerprint)).toEqual([await blobSha(OLD)])
    expect(state.live_only_mounts ?? []).not.toContain('/gh/')
    await load(state, await vfsOf())
    gh.set('docs/a.txt', NEW)
    await expect(load(state, await vfsOf())).rejects.toBeInstanceOf(ContentDriftError)
  })

  it('asks one directory when the drift check runs on a live mount', async () => {
    const vfs = await vfsOf()
    const w = await ws(vfs)
    try {
      await out(w, `cat ${PATH}`)
      const state = await toStateDict(w)
      gh.set('docs/a.txt', NEW)
      gh.log.length = 0
      await expect(load(state, vfs)).rejects.toBeInstanceOf(ContentDriftError)
      expect([gh.count('dir'), gh.count('recursive')]).toEqual([1, 0])
    } finally {
      await w.close()
    }
  })

  it('does not call a refused drift check drift', async () => {
    const vfs = await vfsOf()
    const w = await ws(vfs)
    try {
      await out(w, `cat ${PATH}`)
      const state = await toStateDict(w)
      // The one-directory route is refused while the whole tree would answer:
      // deferring on 401 would pass the check silently.
      gh.fail.set('dir', [401, 'Bad credentials'])
      const err = await load(state, vfs).catch((e: unknown) => e)
      expect(err).not.toBeInstanceOf(ContentDriftError)
      expect((err as { status?: number }).status).toBe(401)
    } finally {
      await w.close()
    }
  })

  it('still loads a snapshot from before github pinned', async () => {
    const state = await pinnedState()
    state.fingerprints = (state.fingerprints ?? []).filter((f) => !f.path.startsWith('/gh/'))
    state.live_only_mounts = ['/gh/']
    // No pin, so nothing is checked and nothing raises under STRICT; the
    // override mount reads bounded and serves the restored copy.
    expect(await load(state, await vfsOf())).toBe(OLD)
  })
})
