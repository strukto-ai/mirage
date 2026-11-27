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

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import { GitHubRepo, TOKEN, blobSha } from '../../../tests/core/github/repo.ts'
import { LISTING_TRUST_WINDOW } from '../../cache/index/constants.ts'
import { ManualClock } from '../../utils/clock.ts'
import { DEFAULT_READ_TTL, MountMode, ReadPolicy } from '../../types.ts'
import type { BaseVFS } from '../base.ts'
import { RAMVFS } from '../ram/ram.ts'
import { Mount } from '../../workspace/mount/spec.ts'
import { ContentDriftError } from '../../workspace/snapshot/drift.ts'
import { toStateDict } from '../../workspace/snapshot/state.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { GitHubVFS } from './github.ts'

const DEC = new TextDecoder()
const OLD = 'version one\n'
const NEW = 'version two, longer\n'
const PATH = '/gh/docs/a.txt'

const FILES = { 'docs/a.txt': OLD, 'docs/b.txt': 'bravo', 'top.txt': 'top' }

let origin: string
let repo: GitHubRepo

beforeAll(async () => {
  origin = await serve('github')
})

beforeEach(async () => {
  repo = new GitHubRepo(origin)
  await repo.create(FILES)
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await repo.run.close()
})

// The decisions count what happens once the mount is made.
async function vfsOf(): Promise<GitHubVFS> {
  const vfs = await GitHubVFS.create({
    token: TOKEN,
    owner: repo.owner,
    repo: repo.name,
    ref: 'main',
    baseUrl: repo.run.url,
  })
  await repo.run.recordRequests()
  return vfs
}

function ws(
  vfs: BaseVFS,
  policy: ReadPolicy = ReadPolicy.FRESH,
  prefix = '/gh',
  clock?: ManualClock,
): Workspace {
  return new Workspace(
    {
      [prefix]: new Mount(vfs, { mode: MountMode.READ, read: { policy, ttl: DEFAULT_READ_TTL } }),
      '/r': [new RAMVFS(), MountMode.WRITE],
    },
    { ...(clock === undefined ? {} : { clock }) },
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
  it('does not let a warm probe bypass a session hidden path', async () => {
    const w = ws(await vfsOf())
    try {
      expect(await out(w, `cat ${PATH}`)).toBe(OLD)
      const session = w.createSession('hidden')
      session.visibility = { ...session.visibility, paths: { paths: [PATH] } }
      const result = await w.shell(`cat ${PATH}`, { sessionId: 'hidden' })
      expect(DEC.decode(result.stdout)).toBe('')
      expect(result.exitCode).toBe(1)
      expect(DEC.decode(result.stderr)).toContain('No such file or directory')
    } finally {
      await w.close()
    }
  })

  // A mount at /src over a repository holding a src/ directory is the decoy:
  // a record labelled repo-relative or mount-relative lands on a key the
  // cache never asks for, so the entry would carry no token.
  for (const prefix of ['/', '/gh', '/src']) {
    it(`leaves the read's sha on the cache entry (${prefix})`, async () => {
      await repo.replace({ 'src/a.txt': OLD })
      const w = ws(await vfsOf(), ReadPolicy.FRESH, prefix)
      const path = `${prefix === '/' ? '' : prefix}/src/a.txt`
      try {
        expect(await out(w, `cat ${path}`)).toBe(OLD)
        expect(await w.cache.isFresh(path, blobSha(OLD))).toBe(true)
      } finally {
        await w.close()
      }
    })
  }

  // Each cell is [dir listings, whole-tree walks, blob downloads] for one line
  // on a warm fresh mount: a command pays one probe, at its first stat of the
  // operand its line names, as hf's table does; its own stat and the cache
  // stage both reuse that answer. On github the probe is one check of the
  // head, which replaces the tree refetch (Task 1.3).
  const WARM: [string, [number, number, number]][] = [
    [`cat ${PATH}`, [1, 0, 0]],
    [`cat ${PATH} | head -c 1`, [1, 0, 0]],
    [`cp ${PATH} /r/a.txt`, [1, 0, 0]],
  ]
  for (const [line, cost] of WARM) {
    it(`costs one listing per probe: ${line}`, async () => {
      const w = ws(await vfsOf())
      try {
        await out(w, `cat ${PATH}`)
        await repo.run.recordRequests()
        await out(w, line)
        expect(await repo.counts()).toEqual(cost)
      } finally {
        await w.close()
      }
    })
  }

  // The command's stat now comes from the freshness probe rather than from
  // the command's own lookup; what it prints must not change with it.
  it('prints the same warm stat as a bounded mount', async () => {
    const outs: string[] = []
    for (const policy of [ReadPolicy.FRESH, ReadPolicy.BOUNDED]) {
      const w = ws(await vfsOf(), policy)
      try {
        await out(w, `cat ${PATH}`)
        outs.push(await out(w, `stat ${PATH}`))
      } finally {
        await w.close()
      }
    }
    expect(outs[0]).toBe(outs[1])
    expect(outs[0]).not.toBe('')
  })

  // The operand probe checks a path that carries an attribute overlay even when nothing
  // is cached, so under fresh the command's stat of it comes from the probe;
  // the overlay must still apply on top.
  it('prints the same cold stat of an overlaid path as a bounded mount', async () => {
    const outs: string[] = []
    for (const policy of [ReadPolicy.FRESH, ReadPolicy.BOUNDED]) {
      const w = ws(await vfsOf(), policy)
      try {
        await w.namespace.setAttrs(PATH, { mode: 0o600 })
        outs.push(await out(w, `stat -c '%a %s %n' ${PATH}`))
      } finally {
        await w.close()
      }
    }
    expect(outs[0]).toBe(outs[1])
    expect(outs[0]).toBe(`600 ${String(OLD.length)} ${PATH}\n`)
  })

  it('refetches a changed file once, then serves it warm', async () => {
    const w = ws(await vfsOf())
    try {
      expect(await out(w, `cat ${PATH}`)).toBe(OLD)
      await repo.commit({ 'docs/a.txt': NEW })
      await repo.run.recordRequests()
      expect(await out(w, `cat ${PATH}`)).toBe(NEW)
      // The probe finds a new sha; cat's own stat serves the probe's answer,
      // and the read is handed it and downloads.
      expect(await repo.counts()).toEqual([1, 0, 1])
      await repo.run.recordRequests()
      expect(await out(w, `cat ${PATH}`)).toBe(NEW)
      // Warm now: the operand probe, and nothing else.
      expect(await repo.counts()).toEqual([1, 0, 0])
    } finally {
      await w.close()
    }
  })

  it('serves the cache on a bounded mount', async () => {
    const w = ws(await vfsOf(), ReadPolicy.BOUNDED)
    try {
      expect(await out(w, `cat ${PATH}`)).toBe(OLD)
      await repo.commit({ 'docs/a.txt': NEW })
      await repo.run.recordRequests()
      expect(await out(w, `cat ${PATH}`)).toBe(OLD)
      expect(await repo.counts()).toEqual([0, 0, 0])
    } finally {
      await w.close()
    }
  })

  it('asks a new mount one directory per stat until it lists', async () => {
    const w = ws(await vfsOf())
    try {
      await out(w, `stat ${PATH}`)
      await out(w, `stat ${PATH}`)
      await out(w, 'ls /gh/docs')
      // create fetched the tree but seeded no index, so each stat asks one
      // directory until the listing fills it.
      expect(await repo.counts()).toEqual([2, 1, 0])
      // The listing filled the index, but under fresh the next command
      // re-checks it once: one check of the head, which replaces the tree
      // refetch (Task 1.3).
      await out(w, `stat ${PATH}`)
      expect(await repo.counts()).toEqual([3, 1, 0])
    } finally {
      await w.close()
    }
  })

  // A bounded mount lists its way to the first stat with one tree, which
  // names every folder, so every stat and listing after it is free.
  it('lists a bounded mount once for its stats', async () => {
    const w = ws(await vfsOf(), ReadPolicy.BOUNDED)
    try {
      await out(w, `stat ${PATH}`)
      expect(await repo.counts()).toEqual([0, 1, 0])
      await out(w, `stat ${PATH}`)
      await out(w, 'ls /gh/docs')
      await out(w, `stat ${PATH}`)
      expect(await repo.counts()).toEqual([0, 1, 0])
    } finally {
      await w.close()
    }
  })

  it('reads a revert through both reads', async () => {
    // Content-addressed shas make every stamp source agree once the index is
    // refilled, so this guards that both the stream read (cat) and the bytes
    // read (cp) stamp, rather than telling stamp sources apart.
    const w = ws(await vfsOf())
    try {
      for (const [step, data] of [OLD, NEW, OLD].entries()) {
        await repo.commit({ 'docs/a.txt': data })
        expect(await out(w, `cat ${PATH}`)).toBe(data)
        await out(w, `cp ${PATH} /r/c${String(step)}`)
        expect(await out(w, `cat /r/c${String(step)}`)).toBe(data)
        const sha = blobSha(data)
        expect(await w.cache.isFresh(PATH, sha)).toBe(true)
        expect(await repo.log()).toContainEqual(['blob', sha])
      }
    } finally {
      await w.close()
    }
  })

  it('reads the new blob on a cold read after an outside change', async () => {
    // The limit this used to pin (a cold read served the listed sha until the
    // next probe) is gone: fresh re-checks the listing a new command reads,
    // so even the first read resolves the current blob.
    const w = ws(await vfsOf())
    try {
      await out(w, 'ls /gh/docs')
      await repo.commit({ 'docs/a.txt': NEW })
      expect(await out(w, `cat ${PATH}`)).toBe(NEW)
      expect(await w.cache.isFresh(PATH, blobSha(NEW))).toBe(true)
      expect(await out(w, `cat ${PATH}`)).toBe(NEW)
    } finally {
      await w.close()
    }
  })

  it('leaves find its whole listing after a probe', async () => {
    const w = ws(await vfsOf())
    try {
      await out(w, `cat ${PATH}`)
      await out(w, `cat ${PATH}`)
      const walks = await repo.count('recursive')
      const listed = await out(w, 'find /gh -type f')
      expect(listed.split('\n').filter(Boolean).sort()).toEqual([
        '/gh/docs/a.txt',
        '/gh/docs/b.txt',
        '/gh/top.txt',
      ])
      // The probe left the whole listing; find, a new command, re-checks it
      // once under fresh, with a check of the head instead of a refetch of
      // the tree (Task 1.3).
      expect(await repo.count('recursive')).toBe(walks)
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
    const w = ws(await vfsOf())
    try {
      await out(w, `cat ${PATH}`)
      await overlaid(w)
      // Lost access answers 404 on both endpoints: cannot verify, so the copy
      // is dropped and the cold read fails, but nothing is gone.
      await repo.refuse('dir', 404, 'Not Found')
      await repo.refuse('recursive', 404, 'Not Found')
      // GitHub's own message, as any refused github read prints it; python
      // prints aiohttp's rendering of the same 404. Never ENOENT.
      expect(await fails(w, `cat ${PATH}`)).toBe('cat: Not Found\n')
      expect(kept(w)).toBe(true)
      expect(await fails(w, `cp ${PATH} /r/x`)).toBe('cp: Not Found\n')
      expect(kept(w)).toBe(true)
    } finally {
      await w.close()
    }
  })

  it('keeps the overlay for a refused token', async () => {
    const w = ws(await vfsOf())
    try {
      await out(w, `cat ${PATH}`)
      await overlaid(w)
      // A refused token refuses every route: the read fails with the refusal,
      // and the refusal never reads as the file gone.
      await repo.refuse('dir', 401, 'Bad credentials')
      await repo.refuse('recursive', 401, 'Bad credentials')
      expect(await fails(w, `cat ${PATH}`)).toBe('cat: Bad credentials\n')
      expect(kept(w)).toBe(true)
    } finally {
      await w.close()
    }
  })

  it('treats a parent directory gone upstream as gone', async () => {
    const w = ws(await vfsOf())
    try {
      await out(w, `cat ${PATH}`)
      await overlaid(w)
      await repo.commit({ 'docs/a.txt': null })
      await repo.commit({ 'docs/b.txt': null })
      expect(await fails(w, `cat ${PATH}`)).toBe(`cat: ${PATH}: No such file or directory\n`)
      expect(w.namespace.metaFor(PATH) ?? null).toBeNull()
      expect(await w.cache.exists(PATH)).toBe(false)
    } finally {
      await w.close()
    }
  })

  it('treats a file gone from a live directory as gone', async () => {
    const w = ws(await vfsOf())
    try {
      await out(w, `cat ${PATH}`)
      await overlaid(w)
      await repo.commit({ 'docs/a.txt': null })
      await repo.run.recordRequests()
      expect(await fails(w, `cat ${PATH}`)).toBe(`cat: ${PATH}: No such file or directory\n`)
      expect(w.namespace.metaFor(PATH) ?? null).toBeNull()
      // The probe answers absent from one listing of docs/ and drops the
      // stale row; cat's own stat then lists its way there once, and that
      // tree names the file absent too.
      expect(await repo.counts()).toEqual([1, 1, 0])
    } finally {
      await w.close()
    }
  })

  async function clearedWithOverlay(w: Workspace): Promise<void> {
    await out(w, `cat ${PATH}`)
    await w.cache.remove(PATH)
    await w.registry.mountFor(PATH).index.clear()
    await overlaid(w)
    await repo.refuse('dir', 404, 'Not Found')
    await repo.refuse('recursive', 401, 'Bad credentials')
  }

  it('never reads cannot-see as gone through the dispatcher', async () => {
    // No cached copy, so cp's own stat is the op that reaches the backend: an
    // ENOENT there goes through onEnoent, which drops the overlay.
    const w = ws(await vfsOf())
    try {
      await clearedWithOverlay(w)
      expect(await fails(w, `cp ${PATH} /r/x`)).toBe('cp: Bad credentials\n')
      expect(kept(w)).toBe(true)
    } finally {
      await w.close()
    }
  })

  it('never reads cannot-see as gone through the xattr call', async () => {
    const w = ws(await vfsOf())
    try {
      await clearedWithOverlay(w)
      expect(await fails(w, `getfattr -d ${PATH}`)).toBe(`getfattr: ${PATH}: Bad credentials\n`)
      expect(kept(w)).toBe(true)
    } finally {
      await w.close()
    }
  })

  it('does not read a truncated parent listing as absence', async () => {
    const w = ws(await vfsOf())
    try {
      await out(w, `cat ${PATH}`)
      await overlaid(w)
      await repo.cutShort('docs', 0)
      await repo.run.recordRequests()
      expect(await out(w, `cat ${PATH}`)).toBe(OLD)
      expect(kept(w)).toBe(true)
      // The operand probe's listing of docs/ is cut short, so it defers to one
      // walk of the whole tree, which finds the file; cat's own stat and the
      // cache stage reuse its answer.
      expect(await repo.counts()).toEqual([1, 1, 0])
    } finally {
      await w.close()
    }
  })

  it('probes one directory on a truncated repository', async () => {
    await repo.replace({ 'top.txt': 't', 'docs/a.txt': OLD })
    await repo.truncate()
    const vfs = await vfsOf()
    expect(vfs.accessor.treeLoaded).toBe(false)
    const w = ws(vfs)
    try {
      expect(await out(w, `cat ${PATH}`)).toBe(OLD)
      expect(vfs.accessor.truncated).toBe(true)
      await repo.run.recordRequests()
      expect(await out(w, `cat ${PATH}`)).toBe(OLD)
      // One listing of docs/, by the operand probe; cat's own stat and the
      // cache stage reuse its answer, so the truncated tree is never walked
      // folder by folder, which would reach docs/ by its sha.
      expect(await repo.counts()).toEqual([1, 0, 0])
      expect(await repo.count('sha_dir')).toBe(0)
    } finally {
      await w.close()
    }
  })
})

describe('github directories cut short', () => {
  it('does not read a directory GitHub cuts short as absence', async () => {
    // A truncated repository whose docs/ listing GitHub also cuts short: the
    // walk refuses the cut listing rather than caching it whole, so a probe
    // cannot read the file as gone, and the overlay stays.
    await repo.truncate()
    const w = ws(await vfsOf())
    try {
      expect(await out(w, `cat ${PATH}`)).toBe(OLD)
      await w.namespace.setAttrs(PATH, { mode: 0o600 })
      await repo.cutShort('docs', 0)
      expect(await fails(w, `cat ${PATH}`)).toMatch(
        /^cat: GitHub truncated the tree listing of integ-user\/repo /,
      )
      expect(w.namespace.metaFor(PATH)?.mode).toBe(0o600)
    } finally {
      await w.close()
    }
  })
})

describe('github snapshot pins', () => {
  async function pinnedState(vfs?: BaseVFS) {
    const w = ws(vfs ?? (await vfsOf()))
    try {
      await out(w, `cat ${PATH}`)
      return await toStateDict(w)
    } finally {
      await w.close()
    }
  }

  async function load(
    state: Awaited<ReturnType<typeof toStateDict>>,
    vfs: BaseVFS,
  ): Promise<string> {
    const loaded = await Workspace.fromState(
      state,
      {},
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
    expect(pins.map((p) => p.fingerprint)).toEqual([blobSha(OLD)])
    expect(state.live_only_mounts ?? []).not.toContain('/gh/')
    await load(state, await vfsOf())
    await repo.commit({ 'docs/a.txt': NEW })
    const err = await load(state, await vfsOf()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ContentDriftError)
    expect([
      (err as ContentDriftError).snapshotFingerprint,
      (err as ContentDriftError).liveFingerprint,
    ]).toEqual([blobSha(OLD), blobSha(NEW)])
  })

  it('asks one directory when the drift check runs on a live mount', async () => {
    const vfs = await vfsOf()
    const w = ws(vfs)
    try {
      await out(w, `cat ${PATH}`)
      const state = await toStateDict(w)
      await repo.commit({ 'docs/a.txt': NEW })
      await repo.run.recordRequests()
      await expect(load(state, vfs)).rejects.toBeInstanceOf(ContentDriftError)
      expect([await repo.count('dir'), await repo.count('recursive')]).toEqual([1, 0])
    } finally {
      await w.close()
    }
  })

  it('does not call a refused drift check drift', async () => {
    const vfs = await vfsOf()
    const w = ws(vfs)
    try {
      await out(w, `cat ${PATH}`)
      const state = await toStateDict(w)
      // The one-directory route is refused while the whole tree would answer:
      // deferring on 401 would pass the check silently.
      await repo.refuse('dir', 401, 'Bad credentials')
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

it.each(['find /gh', 'du -a /gh', 'ls -R /gh'])(
  'truncated walk lists each directory once: %s',
  async (line) => {
    const folders = ['', 'a', 'a/b', 'a/b/c', 'a/b/c/d']
    // Each folder's tree sha, so a listing asked by sha names its folder.
    const named = new Map<string, string>()
    const nameFolders = async (): Promise<void> => {
      for (const folder of folders) named.set((await repo.tree(`main:${folder}`)).sha, folder)
    }
    await repo.replace({ 'a/b/c/d/e.txt': 'x' })
    await repo.truncate()
    const workspace = ws(await vfsOf())
    try {
      await out(workspace, line)
      await nameFolders()
      await repo.commit({ 'a/b/c/d/new.txt': 'new' })
      await nameFolders()
      await repo.run.recordRequests()
      expect(await out(workspace, line)).toContain('new.txt')
      const listed = (await repo.log()).flatMap(([kind, segment]) => {
        if (kind === 'sha_dir') return [named.get(segment) ?? segment]
        if (kind === 'dir') return [decodeURIComponent(segment).split(':').slice(1).join(':')]
        return []
      })
      expect(listed.sort()).toEqual(folders)
    } finally {
      await workspace.close()
    }
  },
)

// The dispatcher is what FUSE, ws.vfs and the agent file tools reach, and none
// of them runs inside a shell command. One `ls -l` over FUSE is a readdir and
// a stat per entry; fresh trusts a listing that recent instead of refetching
// the whole tree for every call.
describe('github dispatcher under read: fresh', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('fetches the tree once for a burst', async () => {
    await repo.replace(
      Object.fromEntries(
        Array.from({ length: 20 }, (_, n) => [`docs/f${String(n).padStart(2, '0')}.txt`, 'x']),
      ),
    )
    const w = ws(await vfsOf())
    try {
      const names = await w.readdir('/gh/docs')
      expect(names).toHaveLength(20)
      for (const name of names) await w.stat(name)
      expect(await repo.count('recursive')).toBe(1)
    } finally {
      await w.close()
    }
  })

  it('sees an outside change after the window', async () => {
    const clock = new ManualClock(100)
    const w = ws(await vfsOf(), ReadPolicy.FRESH, '/gh', clock)
    try {
      expect(await w.readdir('/gh/docs')).not.toContain('/gh/docs/c.txt')
      await repo.commit({ 'docs/c.txt': 'new' })
      clock.advance(LISTING_TRUST_WINDOW)
      expect(await w.readdir('/gh/docs')).toContain('/gh/docs/c.txt')
    } finally {
      await w.close()
    }
  })
})
