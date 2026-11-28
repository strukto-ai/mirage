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

import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { RAMVFS } from '../../../../vfs/ram/ram.ts'
import { ALL_COMMANDS } from '../../../../policy/builtin/output_cap.ts'
import { Limit, MountMode, PathSpec } from '../../../../types.ts'
import type { SessionProfile } from '../../../../policy/profile.ts'
import { ManualClock, runWithSystemClock } from '../../../../utils/clock.ts'
import { Workspace } from '../../../../workspace/workspace/workspace.ts'
import { GIT } from './index.ts'
import { ensureDir } from './io.ts'

const BUILDER = fileURLToPath(
  new URL('../../../../../../../../integ/fixtures/git/build.sh', import.meta.url),
)
const DEC = new TextDecoder()

let tmp: string
const roots: string[] = []

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mirage-git-status-'))
})

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function walk(root: string, base = root): string[] {
  const out: string[] = []
  for (const entry of readdirSync(root)) {
    const full = join(root, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full, base))
    else out.push(relative(base, full).split(sep).join('/'))
  }
  return out
}

/** What the user does to the repository before status is asked. */
type Setup = (repo: string) => void

/**
 * Build the fixture, apply a setup, then mirror the whole tree into RAM.
 *
 * Both sides see the same bytes: the real binary answers off the disk copy and
 * mirage answers off the RAM one, so any difference is mirage's.
 */
async function stage(
  setup: Setup,
  profiles: Record<string, SessionProfile> = {},
): Promise<[Workspace, string]> {
  const repo = mkdtempSync(join(tmp, 'repo-'))
  roots.push(repo)
  execFileSync('bash', [BUILDER, repo], { stdio: 'ignore' })
  setup(repo)

  const ram = new RAMVFS()
  const ws = new Workspace({ '/repo': ram }, { mode: MountMode.WRITE, profiles })
  const dispatch = ws.vfs
  for (const rel of walk(repo)) {
    const target = `/repo/${rel}`
    await ensureDir(dispatch, PathSpec.fromStrPath(target).parent)
    await ws.dispatch('write', target, [new Uint8Array(readFileSync(join(repo, rel)))])
    // The mode rides along, because git tracks the owner's execute bit and a
    // mirror that dropped it would make a `chmod +x` invisible to the copy under
    // test while the real binary still reports it.
    await ws.dispatch('setattr', target, [], { mode: statSync(join(repo, rel)).mode })
  }
  ws.registerCli('git', GIT)
  return [ws, repo]
}

/** Write a file, creating the directories above it. */
function put(repo: string, path: string, text: string): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true })
  writeFileSync(join(repo, path), text)
}

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
}

/** Both answers to the same `git status` spelling, mirage's first. */
async function both(setup: Setup, spelling: string[], sub = ''): Promise<[string, string]> {
  const [ws, repo] = await stage(setup)
  const result = await ws.shell(`git -C ${join('/repo', sub)} status ${spelling.join(' ')}`)
  return [DEC.decode(result.stdout), git(join(repo, sub), ['status', ...spelling])]
}

// Every spelling git offers for the same report, so a divergence in one format
// cannot hide behind another.
const SPELLINGS = [[], ['--porcelain'], ['-s'], ['-sb'], ['--porcelain', '-b'], ['-uall']]

// Each row is a repository state and what the user did to reach it. The real
// binary is the truth for every one of them.
const STATES: [string, Setup][] = [
  ['a clean tree', () => undefined],
  [
    'an unstaged edit',
    (r) => {
      put(r, 'letters.txt', 'edited\n')
    },
  ],
  [
    'a staged edit',
    (r) => {
      put(r, 'letters.txt', 'edited\n')
      git(r, ['add', '-A'])
    },
  ],
  [
    'a staged edit and another on top',
    (r) => {
      put(r, 'letters.txt', 'edited\n')
      git(r, ['add', '-A'])
      put(r, 'letters.txt', 'edited again\n')
    },
  ],
  [
    'an untracked file',
    (r) => {
      put(r, 'fresh.txt', 'x\n')
    },
  ],
  [
    'an untracked directory',
    (r) => {
      put(r, 'newdir/inner.txt', 'x\n')
    },
  ],
  [
    'an untracked directory holding only ignored files',
    (r) => {
      put(r, '.gitignore', '*.log\n')
      put(r, 'logs/a.log', 'x\n')
    },
  ],
  [
    'a deleted tracked file',
    (r) => {
      rmSync(join(r, 'numbers.txt'))
    },
  ],
  [
    'a staged deletion',
    (r) => {
      rmSync(join(r, 'numbers.txt'))
      git(r, ['add', '-A'])
    },
  ],
  [
    'a staged new file',
    (r) => {
      put(r, 'fresh.txt', 'x\n')
      git(r, ['add', '-A'])
    },
  ],
  [
    'an ignored file',
    (r) => {
      put(r, '.gitignore', '*.log\n')
      put(r, 'debug.log', 'x\n')
      git(r, ['add', '.gitignore'])
    },
  ],
  [
    'a negated ignore rule',
    (r) => {
      put(r, '.gitignore', '*.log\n!keep.log\n')
      put(r, 'debug.log', 'x\n')
      put(r, 'keep.log', 'x\n')
      git(r, ['add', '.gitignore'])
    },
  ],
  [
    'a nested gitignore',
    (r) => {
      put(r, 'sub/.gitignore', '*.tmp\n')
      put(r, 'sub/a.tmp', 'x\n')
      put(r, 'sub/b.txt', 'x\n')
    },
  ],
  [
    'a tracked file inside an ignored directory',
    (r) => {
      put(r, '.gitignore', 'build/\n')
      put(r, 'build/kept.txt', 'x\n')
      git(r, ['add', '-f', 'build/kept.txt', '.gitignore'])
      git(r, ['commit', '-q', '-m', 'track inside ignored'])
      put(r, 'build/kept.txt', 'edited\n')
    },
  ],
  [
    'an exact rename',
    (r) => {
      git(r, ['mv', 'numbers.txt', 'digits.txt'])
    },
  ],
  [
    'a rename that also edited the file',
    (r) => {
      git(r, ['mv', 'letters.txt', 'chars.txt'])
      put(r, 'chars.txt', 'alpha\nbeta\ngamma\ndelta\nepsilon\n')
      git(r, ['add', '-A'])
    },
  ],
  [
    'a same-size edit',
    (r) => {
      put(r, 'numbers.txt', 'ONE\nTWO\n')
    },
  ],
  [
    'a path with a space',
    (r) => {
      put(r, 'two words.txt', 'x\n')
    },
  ],
  [
    'a path with a quote',
    (r) => {
      put(r, 'quo"te.txt', 'x\n')
    },
  ],
  [
    'a non-ASCII path',
    (r) => {
      put(r, 'ünïcødé.txt', 'x\n')
    },
  ],
  [
    'non-ASCII paths with core.quotePath off',
    (r) => {
      put(r, 'ünïcødé.txt', 'x\n')
      git(r, ['mv', 'letters.txt', 'lëtters.txt'])
      put(r, 'tab\there.txt', 'x\n')
      git(r, ['config', 'core.quotePath', 'false'])
    },
  ],
  [
    'a detached HEAD',
    (r) => {
      git(r, ['checkout', '-q', 'HEAD~1'])
    },
  ],
  [
    'a mode change',
    (r) => {
      execFileSync('chmod', ['+x', join(r, 'numbers.txt')])
    },
  ],
]

describe('git status against the real binary', () => {
  const rows = STATES.flatMap(([name, setup]) =>
    SPELLINGS.map(
      (spelling) => [`${name} / git status ${spelling.join(' ')}`, setup, spelling] as const,
    ),
  )
  it.each(rows)('matches on %s', async (_name, setup, spelling) => {
    const [mine, theirs] = await both(setup, [...spelling])
    expect(mine).toBe(theirs)
  })
})

// The human formats name every path from where git runs; porcelain is left to
// the top-level run above, since it never does.
describe('git status from a subdirectory against the real binary', () => {
  const rows = STATES.flatMap(([name, setup]) =>
    [[], ['-s'], ['-uall']].map(
      (spelling) =>
        [`${name} / git -C docs status ${spelling.join(' ')}`, setup, spelling] as const,
    ),
  )
  it.each(rows)('matches on %s', async (_name, setup, spelling) => {
    const [mine, theirs] = await both(setup, [...spelling], 'docs')
    expect(mine).toBe(theirs)
  })
})

describe('status under a hide', () => {
  it('a rename from a hidden path reads as an add', async () => {
    // The source and the destination are two rows: the hide drops the source
    // alone, so the session sees a file appear, and no format names or counts
    // the path it came from.
    const [ws, repo] = await stage(
      (r) => {
        git(r, ['mv', 'letters.txt', 'moved.txt'])
      },
      { veiled: { paths: { hide: ['/repo/letters.txt'] } } },
    )
    ws.createSession('v', { profile: 'veiled' })
    const lines =
      'git -C /repo status --porcelain; git -C /repo diff --cached --stat; ' +
      'git -C /repo diff --cached --name-status'
    const veiled = await ws.shell(lines, { sessionId: 'v' })
    expect(DEC.decode(veiled.stdout)).toBe(
      'A  moved.txt\n moved.txt | 4 ++++\n 1 file changed, 4 insertions(+)\nA\tmoved.txt\n',
    )
    const full = await ws.shell(lines)
    expect(DEC.decode(full.stdout)).toBe(
      git(repo, ['status', '--porcelain']) +
        git(repo, ['diff', '--cached', '--stat']) +
        git(repo, ['diff', '--cached', '--name-status']),
    )
  })

  it('a directory whose only tracked file is hidden reads as untracked', async () => {
    // The walk collapses by the session's view of the index, so the report has
    // the shape a checkout of what the session sees has.
    const [ws, repo] = await stage(
      (r) => {
        put(r, 'docs/new.txt', 'n\n')
      },
      { veiled: { paths: { hide: ['/repo/docs/readme.md'] } } },
    )
    ws.createSession('v', { profile: 'veiled' })
    const line = 'git -C /repo status --porcelain'
    expect(DEC.decode((await ws.shell(line, { sessionId: 'v' })).stdout)).toBe('?? docs/\n')
    expect(DEC.decode((await ws.shell(line)).stdout)).toBe(git(repo, ['status', '--porcelain']))
  })
})

describe('git status --show-stash against the real binary', () => {
  it('reports what git reports', async () => {
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: 'Ada',
      GIT_AUTHOR_EMAIL: 'ada@example.com',
      GIT_COMMITTER_NAME: 'Ada',
      GIT_COMMITTER_EMAIL: 'ada@example.com',
    }
    const [mine, theirs] = await both(
      (r) => {
        put(r, 'letters.txt', 'edited\n')
        execFileSync('git', ['-C', r, 'stash', '-q'], { env })
      },
      ['--show-stash'],
    )
    expect(mine).toBe(theirs)
  })
})

describe('a narrow path', () => {
  it.each(['status --short -- a.txt', 'ls-files -o --directory -- a.txt'])(
    'git %s walks no other untracked directory',
    async (line) => {
      const ws = new Workspace(
        {
          '/repo': [new RAMVFS(), MountMode.WRITE, { [ALL_COMMANDS]: new Limit({ walkLimit: 4 }) }],
        },
        { mode: MountMode.WRITE },
      )
      ws.registerCli('git', GIT)
      try {
        await ws.shell(
          'cd /repo && git init -q && echo one > a.txt && echo two > b.txt && ' +
            'git add a.txt b.txt && mkdir vendor && ' +
            'for n in 1 2 3 4 5 6 7 8; do echo x > vendor/$n.txt; done',
        )
        const result = await ws.shell(`git -C /repo ${line}`)
        expect(result.exitCode).toBe(0)
      } finally {
        await ws.close()
      }
    },
  )
})

/** Keeps listings past the command, as a disk or bucket mount does. */
class KeptRAM extends RAMVFS {
  override readonly indexTtl: number = 600
}

/** Serves reads from the workspace's file cache, as a bucket mount does under
 * `read: bounded`. */
class CachedRAM extends RAMVFS {
  override readonly cachesReads: boolean = true
}

/** A one-commit repository mirrored into RAM at `/w/work`, git installed. */
async function source(vfs: RAMVFS = new RAMVFS()): Promise<Workspace> {
  const repo = mkdtempSync(join(tmp, 'src-'))
  roots.push(repo)
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'A',
    GIT_AUTHOR_EMAIL: 'a@example.com',
    GIT_COMMITTER_NAME: 'A',
    GIT_COMMITTER_EMAIL: 'a@example.com',
  }
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { env })
  put(repo, 'a.txt', 'one\n')
  put(repo, 'sub/b.txt', 'two\n')
  execFileSync('git', ['-C', repo, 'add', '-A'], { env })
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'first'], { env })
  const ws = new Workspace({ '/w': vfs }, { cache: {}, mode: MountMode.WRITE })
  for (const rel of walk(repo)) {
    const target = `/w/work/${rel}`
    await ensureDir(ws.vfs, PathSpec.fromStrPath(target).parent)
    await ws.dispatch('write', target, [new Uint8Array(readFileSync(join(repo, rel)))])
  }
  ws.registerCli('git', GIT)
  return ws
}

/** The clone's own files a run of the op log read since `start`. */
function worktreeReads(ws: Workspace, start: number): string[] {
  return ws.records
    .slice(start)
    .filter((r) => r.op === 'read' && r.path.startsWith('/w/dst/'))
    .filter((r) => !r.path.startsWith('/w/dst/.git/'))
    .map((r) => r.path)
}

describe('fingerprints the index keeps', () => {
  it("spare a clone's status every read and still show an edit", async () => {
    // A RAM mount stamps every write past the one before, so the clock standing
    // still (as a Durable Object's does for a whole request) still moves the
    // fingerprint of a same-size edit made after the clone. Mirrors Python's
    // test_a_clone_s_status_reads_none_of_its_files_yet_sees_an_edit.
    const ws = await source()
    try {
      const [reads, changed] = await runWithSystemClock(
        new ManualClock(1_800_000_000),
        async () => {
          const cloned = await ws.shell('git clone -q /w/work /w/dst')
          expect([cloned.exitCode, DEC.decode(cloned.stderr)]).toEqual([0, ''])
          const start = ws.records.length
          const clean = await ws.shell('git -C /w/dst status --porcelain')
          expect([clean.exitCode, DEC.decode(clean.stdout)]).toEqual([0, ''])
          const seen = worktreeReads(ws, start)
          const edited = await ws.shell('sed -i s/one/ONE/ /w/dst/a.txt')
          expect(edited.exitCode).toBe(0)
          const after = await ws.shell('git -C /w/dst status --porcelain')
          return [seen, DEC.decode(after.stdout)] as const
        },
      )
      expect(reads).toEqual([])
      expect(changed).toBe(' M a.txt\n')
    } finally {
      await ws.close()
    }
  })

  it('still show an edit under a time set back by hand', async () => {
    // touch -r after a same-size edit puts back the time the clone gave the
    // file; the RAM fingerprint carries the stamp of that set, so it is not the
    // one the index kept. Mirrors Python's
    // test_a_time_set_back_by_hand_still_shows_the_edit_under_it.
    const ws = await source()
    try {
      const changed = await runWithSystemClock(new ManualClock(1_800_000_000), async () => {
        const cloned = await ws.shell('git clone -q /w/work /w/dst')
        expect(cloned.exitCode).toBe(0)
        const before = await ws.vfs.stat('/w/dst/a.txt')
        const edited = await ws.shell('sed -i s/one/ONE/ /w/dst/a.txt')
        expect(edited.exitCode).toBe(0)
        await ws.vfs.setattr('/w/dst/a.txt', { mtime: before.modified ?? '' })
        return DEC.decode((await ws.shell('git -C /w/dst status --porcelain')).stdout)
      })
      expect(changed).toBe(' M a.txt\n')
    } finally {
      await ws.close()
    }
  })

  it.each([
    ['RAM', () => new RAMVFS(), true],
    ['a cache-served mount', () => new CachedRAM(), false],
  ] as const)('are kept by add on %s only where reads ask the backend', async (_, make, kept) => {
    // A body the cache serves unasked may be older than the fingerprint a stat
    // gives beside the read, so add keeps none there: kept beside the old
    // bytes' blob, it would let a status trust an edit away once the cache let
    // the old bytes go. The index's first entry is a.txt; its dev and ino sit
    // at bytes 28 and 32. Mirrors Python's
    // test_an_add_keeps_a_fingerprint_only_where_reads_ask_the_backend.
    const ws = await source(make())
    try {
      const cloned = await ws.shell('git clone -q /w/work /w/dst')
      expect(cloned.exitCode).toBe(0)
      const edited = await ws.shell('sed -i s/one/ONE/ /w/dst/a.txt')
      expect(edited.exitCode).toBe(0)
      const added = await ws.shell('git -C /w/dst add a.txt')
      expect(added.exitCode).toBe(0)
      const index = await ws.vfs.read('/w/dst/.git/index')
      const view = new DataView(index.buffer, index.byteOffset, index.byteLength)
      expect(view.getUint32(28) !== 0 || view.getUint32(32) !== 0).toBe(kept)
    } finally {
      await ws.close()
    }
  })

  it('are asked past the listings a mount keeps', async () => {
    // The second workspace's write never reaches the first one's kept listing,
    // so the walk there still answers the file's old fingerprint; status has to
    // ask the backend before it trusts it. Mirrors Python's
    // test_a_status_asks_past_the_listings_a_mount_keeps.
    const vfs = new KeptRAM()
    const ws = await source(vfs)
    const other = new Workspace({ '/w': vfs }, { mode: MountMode.WRITE })
    try {
      const cloned = await ws.shell('git clone -q /w/work /w/dst')
      expect(cloned.exitCode).toBe(0)
      const clean = await ws.shell('git -C /w/dst status --porcelain')
      expect([clean.exitCode, DEC.decode(clean.stdout)]).toEqual([0, ''])
      await other.vfs.write('/w/dst/a.txt', 'ONE\n')
      const changed = await ws.shell('git -C /w/dst status --porcelain')
      expect(DEC.decode(changed.stdout)).toBe(' M a.txt\n')
    } finally {
      await other.close()
      await ws.close()
    }
  })

  it('see a mode change their kept listing missed', async () => {
    // chmod moves a mode, not the bytes or their fingerprint, so the fresh stat
    // status takes past the kept listing is what carries it. Mirrors Python's
    // test_a_status_sees_a_mode_change_its_kept_listing_missed.
    const vfs = new KeptRAM()
    const ws = await source(vfs)
    const other = new Workspace({ '/w': vfs }, { mode: MountMode.WRITE })
    try {
      const cloned = await ws.shell('git clone -q /w/work /w/dst')
      expect(cloned.exitCode).toBe(0)
      const clean = await ws.shell('git -C /w/dst status --porcelain')
      expect([clean.exitCode, DEC.decode(clean.stdout)]).toEqual([0, ''])
      await other.vfs.setattr('/w/dst/a.txt', { mode: 0o755 })
      const changed = await ws.shell('git -C /w/dst status --porcelain')
      expect(DEC.decode(changed.stdout)).toBe(' M a.txt\n')
    } finally {
      await other.close()
      await ws.close()
    }
  })

  it('are kept by a checkout for a file it had to read', async () => {
    // touch moves a file's time and so its fingerprint, not its bytes: status
    // reads it to find it unchanged, and the checkout that reads it too keeps
    // the new fingerprint in the index it writes. Mirrors Python's
    // test_a_checkout_keeps_the_fingerprint_of_a_file_it_had_to_read.
    const ws = await source()
    try {
      const cloned = await ws.shell('git clone -q /w/work /w/dst')
      expect(cloned.exitCode).toBe(0)
      expect((await ws.shell('touch /w/dst/a.txt')).exitCode).toBe(0)
      let start = ws.records.length
      const status = await ws.shell('git -C /w/dst status --porcelain')
      expect([status.exitCode, DEC.decode(status.stdout)]).toEqual([0, ''])
      expect(worktreeReads(ws, start)).toEqual(['/w/dst/a.txt'])
      const moved = await ws.shell('git -C /w/dst checkout -q --detach')
      expect([moved.exitCode, DEC.decode(moved.stderr)]).toEqual([0, ''])
      start = ws.records.length
      const again = await ws.shell('git -C /w/dst status --porcelain')
      expect([again.exitCode, DEC.decode(again.stdout)]).toEqual([0, ''])
      expect(worktreeReads(ws, start)).toEqual([])
    } finally {
      await ws.close()
    }
  })
})
