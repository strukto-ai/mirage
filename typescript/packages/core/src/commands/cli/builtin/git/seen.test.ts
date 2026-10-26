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

import { runWithAdmission } from '../../../../context/session_context.ts'
import type { SessionProfile } from '../../../../policy/profile.ts'
import type { CommandRule, EntryGate } from '../../../../policy/types.ts'
import { MountMode, PathSpec } from '../../../../types.ts'
import { RAMVFS } from '../../../../vfs/ram/ram.ts'
import { Workspace } from '../../../../workspace/workspace/workspace.ts'
import { typedBytes } from './cat_file.ts'
import { discover } from './discover.ts'
import { GIT } from './index.ts'
import { ensureDir, readOptional } from './io.ts'
import { openRepo, type Repo } from './repo.ts'
import { located, placeOf, readable, shownEntries } from './seen.ts'

const DEC = new TextDecoder()
const ENC = new TextEncoder()

const PROFILES: Record<string, SessionProfile> = {
  veiled: { paths: { hide: ['/repo/secret.txt', '/repo/box/secret.txt'] } },
  boxed: { paths: { hide: ['/repo/box/secret.txt'] } },
  sealed: { commands: { deny: [{ reason: 'sealed', paths: ['/repo/secret.txt'] }] } },
  half: { paths: { hide: ['/repo/a/secret.txt'] } },
  fresh: { commands: { deny: [{ reason: 'fresh', paths: ['/repo/new.txt'] }] } },
  walled: { commands: { deny: [{ reason: 'walled', paths: ['/repo/boxf/secret.txt'] }] } },
}

/** Write one file and commit it. */
async function commit(ws: Workspace, name: string, text: string, message: string): Promise<void> {
  const target = PathSpec.fromStrPath(`/repo/${name}`)
  await ensureDir(ws.vfs, target.parent)
  await ws.dispatch('write', target.virtual, [ENC.encode(text)])
  await ws.shell(`cd /repo && git add ${name} && git commit -q -m ${message}`)
}

/** A repository at /repo holding these commits, one file each, and one session per profile. */
async function repository(
  commits: readonly (readonly [string, string, string])[],
): Promise<Workspace> {
  const ws = new Workspace({ '/repo': new RAMVFS() }, { mode: MountMode.WRITE, profiles: PROFILES })
  ws.registerCli('git', GIT)
  await ws.shell('cd /repo && git init -q')
  for (const [name, text, message] of commits) await commit(ws, name, text, message)
  for (const profile of Object.keys(PROFILES)) ws.createSession(profile, { profile })
  return ws
}

/**
 * A repository whose secret was committed twice, beside a folder holding
 * another secret and a public file; the second version's bytes are also
 * committed at a public place.
 */
function history(): Promise<Workspace> {
  return repository([
    ['ok.txt', 'public\n', 'first'],
    ['secret.txt', 'S3CR3T one\n', 'second'],
    ['box/secret.txt', 'S3CR3T boxed\n', 'third'],
    ['box/pub.txt', 'pub\n', 'fourth'],
    ['secret.txt', 'S3CR3T two\n', 'fifth'],
    ['copy.txt', 'S3CR3T one\n', 'sixth'],
  ])
}

/** Two directories holding the same files, so one tree id stands at two places. */
function twins(): Promise<Workspace> {
  return repository(
    ['a', 'b'].flatMap((side) => [
      [`${side}/secret.txt`, 'S3CR3T twin\n', side] as const,
      [`${side}/pub.txt`, 'pub\n', side] as const,
    ]),
  )
}

/** Run one line in /repo, as a session or unrestricted. */
async function rawShell(
  ws: Workspace,
  line: string,
  session: string | null = null,
): Promise<[number, Uint8Array, Uint8Array]> {
  const io = await ws.shell(
    `cd /repo && ${line}`,
    session === null ? undefined : { sessionId: session },
  )
  return [io.exitCode, io.stdout, io.stderr]
}

/** `rawShell`'s answer as text. */
async function shell(
  ws: Workspace,
  line: string,
  session: string | null = null,
): Promise<[number, string, string]> {
  const [code, out, err] = await rawShell(ws, line, session)
  return [code, DEC.decode(out), DEC.decode(err)]
}

/** The repository at /repo, opened the way a git verb opens it. */
async function guardedRepo(ws: Workspace): Promise<Repo> {
  const vfs = ws.vfs
  const location = await discover(vfs, PathSpec.fromStrPath('/repo'))
  return openRepo(vfs, { ...location, vfs })
}

/** A gate whose rules could reach every place but refuse only one. */
class OnePlaceGate implements EntryGate {
  readonly scoped = true
  readonly granted: readonly CommandRule[] = []
  readonly judged: ReadonlySet<string> = new Set()

  constructor(private readonly refused: string) {}

  scopes(): boolean {
    return true
  }

  refusal(virtual: string): string | null {
    return virtual === this.refused ? 'sealed' : null
  }

  check(virtual: string): void {
    if (this.refusal(virtual) !== null) throw new Error(virtual)
  }
}

describe('what a session is shown of history', () => {
  it('reads a hidden path as one the history never had', async () => {
    const ws = await history()
    for (const line of [
      'git show HEAD:{}',
      'git cat-file -p HEAD:{}',
      'git cat-file -s HEAD:{}',
      'git show :{}',
    ]) {
      const hidden = await shell(ws, line.replace('{}', 'secret.txt'), 'veiled')
      const missing = await shell(ws, line.replace('{}', 'nothere.txt'), 'veiled')
      expect(hidden).toEqual(
        missing.map((part) =>
          typeof part === 'string' ? part.replaceAll('nothere.txt', 'secret.txt') : part,
        ),
      )
    }
    expect(await shell(ws, 'git log -S S3CR3T --format=%s', 'veiled')).toEqual([0, 'sixth\n', ''])
    expect(await shell(ws, 'git grep -l S3CR3T HEAD~1', 'veiled')).toEqual([1, '', ''])
  })

  it('names nothing by an id held only at a hidden place', async () => {
    const ws = await history()
    const [, second] = await shell(ws, 'git rev-parse HEAD:secret.txt')
    const blob = second.trim()
    expect(await shell(ws, `git cat-file -p ${blob}`, 'veiled')).toEqual([
      128,
      '',
      `fatal: Not a valid object name ${blob}\n`,
    ])
    expect((await shell(ws, `git cat-file -e ${blob}`, 'veiled'))[0]).toBe(1)
    // The first version's bytes also stand at a public place.
    const [, first] = await shell(ws, 'git rev-parse HEAD:copy.txt')
    expect(await shell(ws, `git cat-file -p ${first.trim()}`, 'veiled')).toEqual([
      0,
      'S3CR3T one\n',
      '',
    ])
  })

  it('lists what a tree holds at its place', async () => {
    const ws = await history()
    const [, root] = await shell(ws, 'git ls-tree --name-only HEAD', 'boxed')
    expect(root.split(/\s+/)).toContain('secret.txt')
    for (const line of ['git ls-tree --name-only HEAD:box', 'git cat-file -p HEAD:box']) {
      const [code, out] = await shell(ws, line, 'boxed')
      expect(code).toBe(0)
      expect(out).toContain('pub.txt')
      expect(out).not.toContain('secret.txt')
    }
    const [, box] = await shell(ws, 'git rev-parse HEAD:box')
    const [code, out] = await shell(ws, `git ls-tree --name-only ${box.trim()}`, 'boxed')
    expect([code, out]).toEqual([0, 'pub.txt\n'])
    expect(await shell(ws, 'git show HEAD:box', 'boxed')).toEqual([
      0,
      'tree HEAD:box\n\npub.txt\n',
      '',
    ])
    const [shown, listing] = await shell(ws, 'git cat-file -p HEAD^{tree}', 'veiled')
    expect(shown).toBe(0)
    expect(listing).not.toContain('secret.txt')
    expect(listing).toContain('copy.txt')
  })

  it('keeps history content from a rule but not names', async () => {
    const ws = await history()
    for (const [verb, line] of [
      ['show', 'git show HEAD:secret.txt'],
      ['log', 'git log -p'],
      ['grep', 'git grep S3CR3T HEAD'],
      ['cat-file', 'git cat-file -s HEAD:secret.txt'],
    ] as const) {
      expect(await shell(ws, line, 'sealed')).toEqual([
        1,
        '',
        `git ${verb}: /repo/secret.txt: Permission denied\n`,
      ])
    }
    const [code, out] = await shell(ws, 'git log -p -- ok.txt', 'sealed')
    expect(code).toBe(0)
    expect(out).toContain('public')
    const [listed, names] = await shell(ws, 'git ls-tree --name-only HEAD', 'sealed')
    expect(listed).toBe(0)
    expect(names.split(/\s+/)).toContain('secret.txt')
  })

  it('leaves the index as it was when a checkout is refused', async () => {
    const ws = await history()
    const before = await shell(ws, 'git ls-files -s secret.txt')
    const [code, , err] = await shell(ws, 'git checkout HEAD~2 -- secret.txt', 'sealed')
    expect([code, err]).toEqual([1, 'git checkout: /repo/secret.txt: Permission denied\n'])
    expect(await shell(ws, 'git ls-files -s secret.txt')).toEqual(before)
    const data = await readOptional(ws.vfs, PathSpec.fromStrPath('/repo/secret.txt'))
    expect(DEC.decode(data ?? new Uint8Array())).toBe('S3CR3T two\n')
  })

  it.each([false, true])(
    'switches without naming or writing a hidden file (public edit: %s)',
    async (publicEdit) => {
      // A hidden file is no part of the move: an edit to it neither blocks the
      // switch nor is named when another edit does, and it survives.
      const ws = await history()
      await ws.dispatch('write', '/repo/secret.txt', [ENC.encode('S3CR3T edited\n')])
      if (publicEdit) await ws.dispatch('write', '/repo/copy.txt', [ENC.encode('edited\n')])
      const [, out, err] = await shell(
        ws,
        'git checkout -q HEAD~2; echo $?; git log -1 --format=%s',
        'veiled',
      )
      if (publicEdit) {
        expect([out, err]).toEqual([
          '1\nsixth\n',
          'error: Your local changes to the following files would be overwritten by checkout:\n' +
            '\tcopy.txt\nPlease commit your changes or stash them before you switch branches.\nAborting\n',
        ])
      } else {
        expect([out, err]).toEqual(['0\nfourth\n', ''])
      }
      const data = await readOptional(ws.vfs, PathSpec.fromStrPath('/repo/secret.txt'))
      expect(DEC.decode(data ?? new Uint8Array())).toBe('S3CR3T edited\n')
    },
  )

  it('refuses a switch that would remove a hidden file', async () => {
    // A branch recording a file at `box` cannot be written without removing
    // the directory and the hidden box/secret.txt in it, so the switch is
    // refused, naming the path the session sees.
    const ws = await history()
    const [, branch] = await shell(ws, 'git branch --show-current')
    await shell(
      ws,
      'git checkout -q -b flat && git rm -rq box && echo f > box' +
        ' && git add box && git commit -qm flat && git checkout -q ' +
        branch.trim(),
    )
    const [, out, err] = await shell(
      ws,
      'git checkout -q flat; echo $?; git branch --show-current',
      'boxed',
    )
    expect([out, err]).toEqual([
      `1\n${branch}`,
      'error: Your local changes to the following files would be overwritten by checkout:\n' +
        '\tbox\nPlease commit your changes or stash them before you switch branches.\nAborting\n',
    ])
    const data = await readOptional(ws.vfs, PathSpec.fromStrPath('/repo/box/secret.txt'))
    expect(DEC.decode(data ?? new Uint8Array())).toBe('S3CR3T boxed\n')
  })

  it('stands a path in a tree named by id where the tree does', async () => {
    const ws = await history()
    const [, box] = await shell(ws, 'git rev-parse HEAD:box')
    const tree = box.trim()
    const [code, out] = await shell(ws, `git cat-file -p ${tree}:secret.txt`, 'boxed')
    expect(code).toBe(128)
    expect(out).not.toContain('S3CR3T')
    expect(await shell(ws, `git cat-file -p ${tree}:pub.txt`, 'boxed')).toEqual([0, 'pub\n', ''])
  })

  it('names nothing by a tag or a ref naming a hidden blob', async () => {
    const ws = await history()
    const [, second] = await shell(ws, 'git rev-parse HEAD:secret.txt')
    const blob = second.trim()
    await shell(ws, `git tag -a -m 'points at a blob' atag ${blob}`)
    await ws.dispatch('write', '/repo/.git/refs/tags/raw', [ENC.encode(`${blob}\n`)])
    for (const line of [
      'git cat-file blob atag',
      'git show atag',
      "git for-each-ref --format='%(raw)' refs/tags/raw",
      "git for-each-ref --format='%(*raw)' refs/tags/atag",
    ]) {
      const [, out] = await shell(ws, line, 'veiled')
      expect(out, line).not.toContain('S3CR3T')
    }
    expect(await shell(ws, "git for-each-ref --format='%(raw)' refs/tags/raw", 'veiled')).toEqual([
      0,
      '',
      'error: refs/tags/raw does not point to a valid object!\n',
    ])
    const [, out] = await shell(ws, 'git cat-file blob atag')
    expect(out).toBe('S3CR3T two\n')
  })

  it('shows an operand its tree at its own place', async () => {
    const ws = await twins()
    const [code, out] = await shell(ws, 'git grep -l S3CR3T HEAD:a HEAD:b', 'half')
    expect([code, out]).toEqual([0, 'HEAD:b:secret.txt\n'])
    expect(await shell(ws, 'git show HEAD:a HEAD:b', 'half')).toEqual([
      0,
      'tree HEAD:a\n\npub.txt\n\ntree HEAD:b\n\npub.txt\nsecret.txt\n',
      '',
    ])
  })

  it('holds staged content to the rules', async () => {
    const ws = await history()
    await ws.dispatch('write', '/repo/new.txt', [ENC.encode('S3CR3T new\n')])
    expect((await shell(ws, 'git add new.txt'))[0]).toBe(0)
    expect(await shell(ws, 'git diff --cached', 'fresh')).toEqual([
      1,
      '',
      'git diff: /repo/new.txt: Permission denied\n',
    ])
  })

  it('names in raw tree bytes only what is seen', async () => {
    const ws = await history()
    const [code, raw] = await rawShell(ws, 'git cat-file tree HEAD', 'veiled')
    expect(code).toBe(0)
    expect(DEC.decode(raw)).toContain('copy.txt')
    expect(DEC.decode(raw)).not.toContain('secret.txt')
    const [, size] = await shell(ws, 'git cat-file -s HEAD^{tree}', 'veiled')
    expect(Number(size)).toBe(raw.length)
    const [, batch] = await shell(ws, "echo 'HEAD^{tree}' | git cat-file --batch", 'veiled')
    expect(batch).toContain('copy.txt')
    expect(batch).not.toContain('secret.txt')
    const [, tree] = await shell(ws, "git rev-parse 'HEAD^{tree}'")
    await ws.dispatch('write', '/repo/.git/refs/tags/root', [ENC.encode(tree)])
    const [, listed] = await shell(
      ws,
      "git for-each-ref --format='%(raw)' refs/tags/root",
      'veiled',
    )
    expect(listed).toContain('copy.txt')
    expect(listed).not.toContain('secret.txt')
  })

  it('reads a blob where any place lets it', async () => {
    // The same bytes stand at secret.txt in history and at copy.txt; a rule
    // keeps only copy.txt, so they read at secret.txt.
    const ws = await history()
    const [, copied] = await shell(ws, 'git rev-parse HEAD:copy.txt')
    const copy = copied.trim()
    const repo = await guardedRepo(ws)
    await runWithAdmission(new OnePlaceGate('/repo/copy.txt'), async () => {
      expect(await located(repo, { oid: copy, type: 'blob' })).not.toBeNull()
      expect(repo.places.get(copy)).toBe('secret.txt')
      shownEntries(
        repo,
        new Map([
          ['copy.txt', { mode: '100644', oid: copy }],
          ['other.txt', { mode: '100644', oid: copy }],
        ]),
      )
      expect(() => {
        readable(repo, copy)
      }).not.toThrow()
    })
  })

  it('leaves the index as it was when a checkout over a directory is refused', async () => {
    const ws = await repository([['boxf', 'a file\n', 'file']])
    await shell(ws, 'git rm -q boxf')
    await commit(ws, 'boxf/secret.txt', 'S3CR3T dir\n', 'directory')
    const before = await shell(ws, 'git ls-files -s')
    const [code, , err] = await shell(ws, 'git checkout HEAD~1 -- boxf', 'walled')
    expect([code, err]).toEqual([1, 'git checkout: /repo/boxf/secret.txt: Permission denied\n'])
    expect(await shell(ws, 'git ls-files -s')).toEqual(before)
    const data = await readOptional(ws.vfs, PathSpec.fromStrPath('/repo/boxf/secret.txt'))
    expect(DEC.decode(data ?? new Uint8Array())).toBe('S3CR3T dir\n')
  })

  it('reads a commit without walking history', async () => {
    const ws = await history()
    const repo = await guardedRepo(ws)
    await runWithAdmission(new OnePlaceGate('/repo/copy.txt'), async () => {
      const raw = await typedBytes(repo, 'HEAD', 'commit')
      expect(DEC.decode(raw ?? new Uint8Array()).startsWith('tree ')).toBe(true)
      expect(repo.sightings).toBeNull()
    })
  })

  it('sights each place once in the history walk', async () => {
    const ws = await history()
    const [, head] = await shell(ws, 'git rev-parse HEAD')
    const [, ok] = await shell(ws, 'git rev-parse HEAD:ok.txt')
    const repo = await guardedRepo(ws)
    await runWithAdmission(new OnePlaceGate('/repo/copy.txt'), async () => {
      // A commit stands at no place, so this walks all of history.
      await placeOf(repo, head.trim())
      expect(repo.seen.get(ok.trim())).toEqual(['ok.txt'])
    })
  })
})
