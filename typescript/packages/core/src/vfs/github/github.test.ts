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
import type * as Constants from '../../core/github/constants.ts'

const scope = vi.hoisted(() => ({ warn: 1 }))

vi.mock('../../core/github/constants.ts', async () => {
  const actual = await vi.importActual<typeof Constants>('../../core/github/constants.ts')
  return {
    ...actual,
    get SCOPE_WARN(): number {
      return scope.warn
    },
  }
})

import { serve } from '../../../tests/fixtures/kit_fake.ts'
import {
  GitHubRepo,
  TOKEN,
  TREES,
  UNTIL_CLEARED,
  blobSha,
} from '../../../tests/core/github/repo.ts'
import { GitHubConfig } from '../../core/github/config.ts'
import { ensureRef } from '../../core/github/repo.ts'
import { ensureTree } from '../../core/github/tree.ts'
import { ALL_COMMANDS } from '../../policy/builtin/output_cap.ts'
import { Limit, MountMode } from '../../types.ts'
import { Mount } from '../../workspace/mount/spec.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { RAMVFS } from '../ram/ram.ts'
import { parseConfigWithSchema } from '../secrets.ts'
import { GitHubVFS } from './github.ts'

const DEC = new TextDecoder()
const FETCH = globalThis.fetch
const REFUSED_AT_4 = 'more than 4 files in scope (walk_limit); narrow the path\n'
const STOPPED_AT_4 = 'stopped after 4 files (walk_limit); narrow the path\n'
// The tree git names an empty folder by.
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

let origin: string
let repo: GitHubRepo

beforeAll(async () => {
  origin = await serve('github')
})

beforeEach(() => {
  repo = new GitHubRepo(origin)
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await repo.run.close()
})

async function mounted(fields: Record<string, string> = {}): Promise<GitHubVFS> {
  return GitHubVFS.create({
    token: TOKEN,
    owner: repo.owner,
    repo: repo.name,
    baseUrl: repo.run.url,
    ...fields,
  })
}

// GitHub holds an empty folder as an empty tree written through the git
// database; the fake's trees hold files only, so its answers carry the
// folder's row, and the folder lists as empty.
async function withAnEmptyFolder(name: string): Promise<void> {
  const row = { path: name, mode: '040000', type: 'tree', sha: EMPTY_TREE }
  const whole = await repo.tree('main', true)
  const top = await repo.tree('main')
  const answers: [string, string, typeof top][] = [
    ['recursive=1', repo.treePath('main'), whole],
    ['', repo.treePath('main'), top],
    ['', repo.treePath('main:'), top],
  ]
  for (const [query, path, listing] of answers) {
    const grown = { ...listing, tree: [...listing.tree, row] }
    await repo.run.answerNext('GET', TREES, 200, grown, UNTIL_CLEARED, path, query)
  }
  const empty = { sha: EMPTY_TREE, tree: [], truncated: false }
  for (const segment of [EMPTY_TREE, `main:${name}`]) {
    await repo.run.answerNext('GET', TREES, 200, empty, UNTIL_CLEARED, repo.treePath(segment))
  }
}

describe('GitHubVFS', () => {
  it('opens offline and hydrates a repository once across concurrent readers', async () => {
    await repo.create({ 'a.txt': 'a' })
    await repo.branch('trunk')
    await repo.setDefaultBranch('trunk')
    const vfs = await GitHubVFS.create({
      token: TOKEN,
      owner: repo.owner,
      repo: repo.name,
      baseUrl: repo.run.url,
      timeout: 2,
    })
    expect(await repo.log()).toEqual([])
    expect(vfs.accessor.account.config.timeout).toBe(2)
    await Promise.all([ensureTree(vfs.accessor), ensureTree(vfs.accessor), ensureRef(vfs.accessor)])
    await ensureTree(vfs.accessor)
    expect(await repo.log()).toEqual([
      ['repo', ''],
      ['recursive', 'trunk'],
    ])
  })

  for (const [mode, refusal] of [
    [MountMode.READ, 'Read-only file system'],
    [MountMode.WRITE, 'Operation not supported'],
  ] as const) {
    it(`refuses removing a tree entry on a ${mode} mount rather than missing it`, async () => {
      // rm, rmdir and unlink stat their operand first; a file `ls` lists
      // must meet the mount's refusal, -f or not, as GNU's does on a
      // filesystem that refuses the removal. Mirrors the Python test.
      await repo.create({ 'top.txt': 'to' })
      await withAnEmptyFolder('empty')
      const ws = new Workspace({ '/gh': await mounted({ ref: 'main' }) }, { mode })
      try {
        const lines: Record<string, string> = {
          'rm /gh/top.txt': `rm: cannot remove '/gh/top.txt': ${refusal}\n`,
          'rm -f /gh/top.txt': `rm: cannot remove '/gh/top.txt': ${refusal}\n`,
          'rmdir /gh/empty': `rmdir: failed to remove '/gh/empty': ${refusal}\n`,
          'unlink /gh/top.txt': `unlink: cannot unlink '/gh/top.txt': ${refusal}\n`,
          'rm /gh/nope': "rm: cannot remove '/gh/nope': No such file or directory\n",
        }
        for (const [line, stderr] of Object.entries(lines)) {
          const result = await ws.shell(line)
          expect([result.exitCode, DEC.decode(result.stderr)]).toEqual([1, stderr])
        }
        const forced = await ws.shell('rm -f /gh/nope')
        expect([forced.exitCode, DEC.decode(forced.stderr)]).toEqual([0, ''])
        const listed = await ws.shell('ls /gh')
        expect(DEC.decode(listed.stdout)).toBe('empty\ntop.txt\n')
      } finally {
        await ws.close()
      }
    })
  }

  // Python writes an unset field as null, so the config a Python snapshot
  // saves for an anonymous mount names token, app, ref and base_url as null,
  // and a TypeScript workspace rebuilds the mount from it.
  it('builds an anonymous mount from the config a Python snapshot writes', async () => {
    const config = parseConfigWithSchema(GitHubConfig, {
      timeout: 30,
      token: null,
      app: null,
      owner: 'o',
      repo: 'r',
      ref: null,
      base_url: null,
    })
    const vfs = await GitHubVFS.create(config)
    expect(vfs.accessor.account.anonymous).toBe(true)
    expect(vfs.accessor.ref).toBeNull()
    expect(vfs.listingsPin).toBeNull()
  })

  // Mirrors test_find_judges_a_directory_by_what_the_session_sees: a walk
  // asks readTree, which the dispatcher declines under a hide, so -empty sees
  // the directory as the session does.
  it('judges a directory for find by what the session sees', async () => {
    await repo.create({ 'docs/guide.md': 'gui', 'top.txt': 'to' })
    const ws = new Workspace({ '/gh': await mounted({ ref: 'main' }) }, { mode: MountMode.READ })
    try {
      const seen = await ws.shell('find /gh; find /gh -type d -empty')
      expect(DEC.decode(seen.stdout)).toBe('/gh\n/gh/docs\n/gh/docs/guide.md\n/gh/top.txt\n')
      const session = ws.createSession('veiled')
      session.visibility = { ...session.visibility, paths: { paths: ['/gh/docs/guide.md'] } }
      const veiled = await ws.shell('find /gh; find /gh -type d -empty', { sessionId: 'veiled' })
      expect(DEC.decode(veiled.stdout)).toBe('/gh\n/gh/docs\n/gh/top.txt\n/gh/docs\n')
    } finally {
      await ws.close()
    }
  })
})

const LIMIT = 384 * 1024
const REPO: Record<string, string> = {
  'src/a.py': 'import os\nx = 1\n',
  'src/b.py': 'y = 2\n',
  'docs/c.md': 'imports are here\nIMPORT them\n',
  'docs/d.md': 'nothing\n',
  'big.txt': `import\n${'x'.repeat(LIMIT)}`,
}

type Ran = [string, string, number]

async function run(vfs: GitHubVFS | RAMVFS, line: string, limit?: number): Promise<Ran> {
  const commandLimits =
    limit === undefined ? {} : { [ALL_COMMANDS]: new Limit({ walkLimit: limit }) }
  const ws = new Workspace({ '/gh': new Mount(vfs, { mode: MountMode.READ, commandLimits }) }, {})
  try {
    const result = await ws.shell(line)
    return [DEC.decode(result.stdout), DEC.decode(result.stderr), result.exitCode]
  } finally {
    await ws.close()
  }
}

function ram(): RAMVFS {
  const vfs = new RAMVFS()
  const enc = new TextEncoder()
  for (const [key, data] of Object.entries(REPO)) {
    const parts = key.split('/')
    for (let depth = 1; depth < parts.length; depth++) {
      vfs.store.dirs.add(`/${parts.slice(0, depth).join('/')}`)
    }
    vfs.store.files.set(`/${key}`, enc.encode(data))
  }
  return vfs
}

interface Arranged {
  files?: Record<string, string>
  pinned?: boolean
  walkLimit?: number
  refused?: boolean
  truncated?: boolean
}

async function onGithub(line: string, arranged: Arranged = {}): Promise<Ran> {
  const head = await repo.create(arranged.files ?? REPO)
  if (arranged.truncated === true) await repo.truncate()
  if (arranged.refused === true) await repo.refuse('search', 500, 'boom')
  const vfs = await mounted(arranged.pinned === true ? { ref: head } : {})
  return run(vfs, line, arranged.walkLimit ?? 5000)
}

// A file is read by its blob, or in a batch the read-ahead sends.
async function read(): Promise<string[]> {
  const names = new Map<string, string>()
  for (const [path, data] of Object.entries(REPO)) names.set(blobSha(data), path)
  return (await repo.log())
    .filter(([route]) => route === 'blob' || route === 'graphql')
    .flatMap(([, raw]) => raw.split(','))
    .map((sha) => names.get(sha) ?? sha)
    .sort()
}

// github.com's API and raw hosts, reached on the fake's run instead: the
// accessor names them itself, so only the network under it is rerouted.
function onGithubCom(): void {
  const api = 'https://api.github.com'
  const raw = 'https://raw.githubusercontent.com'
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    const routed = url.startsWith(raw)
      ? `${repo.run.url}/raw${url.slice(raw.length)}`
      : url.startsWith(api)
        ? `${repo.run.url}${url.slice(api.length)}`
        : url
    return FETCH(input instanceof Request ? new Request(routed, input) : routed, init)
  })
}

describe('grep and rg over code search', () => {
  beforeEach(() => {
    scope.warn = 1
  })

  // Code search matches whole words in any case and never indexes big.txt,
  // which is past its size limit, so that file is read anyway.
  it.each([
    ['grep -rw import /gh', ['big.txt', 'docs/c.md', 'src/a.py']],
    ['grep -rwi IMPORT /gh/src', ['src/a.py']],
    ['grep -rwc import /gh', ['big.txt', 'docs/c.md', 'src/a.py']],
    ['rg -w import /gh', ['big.txt', 'docs/c.md', 'src/a.py']],
    ['rg -wl import /gh/docs', ['docs/c.md']],
  ])('%s reads only what code search names', async (line, files) => {
    const got = await onGithub(line)
    expect(got).toEqual(await run(ram(), line))
    expect(await repo.count('search')).toBe(1)
    expect(await read()).toEqual(files)
  })

  // The last line's word is a qualifier to code search, which would rescope
  // the query instead of searching for it.
  it.each([
    'grep -r import /gh',
    "grep -rw 'imp.rt' /gh",
    'grep -rwv import /gh',
    'rg -w --files-without-match import /gh',
    'grep -w import /gh/src/a.py /gh/src/b.py',
    "grep -rwF 'path:src' /gh",
  ])('%s reads every file without searching', async (line) => {
    const got = await onGithub(line)
    expect(got).toEqual(await run(ram(), line))
    expect(await repo.count('search')).toBe(0)
  })

  // A truncated tree cannot list the files code search never indexes.
  it.each(['failed', 'truncated-tree'])('a %s search reads every file', async (kind) => {
    const line = 'grep -rw import /gh'
    const got = await onGithub(line, {
      refused: kind === 'failed',
      truncated: kind === 'truncated-tree',
    })
    expect(got).toEqual(await run(ram(), line))
    expect(await read()).toEqual(Object.keys(REPO).sort())
  })

  // Code search indexes the default branch only, so a mount pinned to a
  // commit reads every file as a plain scan does.
  it('reads every file off the default branch', async () => {
    const line = 'grep -rw import /gh'
    const got = await onGithub(line, { pinned: true })
    expect(got).toEqual(await run(ram(), line))
    expect(await repo.count('search')).toBe(0)
    expect(await read()).toEqual(Object.keys(REPO).sort())
  })

  // Twin of test_a_ref_off_the_default_branch_stops_at_the_cap.
  it('stops at the cap off the default branch', async () => {
    const line = 'grep -rw import /gh'
    const got = await onGithub(line, { pinned: true, walkLimit: 4 })
    expect(got).toEqual(await run(ram(), line, 4))
    expect(got.slice(1)).toEqual([`grep: /gh: ${STOPPED_AT_4}`, 2])
    // The walk reads four and warms none past them: the two it read in a row
    // in docs set no pace for src.
    expect(await read()).toEqual(Object.keys(REPO).sort().slice(0, 4))
  })

  // Twin of test_an_anonymous_mount_scans_instead_of_searching: code search
  // refuses a call with no credential, so the walk reads every file, each
  // downloaded.
  it('scans every file of an anonymous mount without searching', async () => {
    await repo.create(REPO)
    onGithubCom()
    const line = 'grep -rw import /gh'
    const got = await run(await GitHubVFS.create({ owner: repo.owner, repo: repo.name }), line)
    expect(got).toEqual(await run(ram(), line))
    expect([
      await repo.count('search'),
      await repo.count('blob'),
      await repo.count('graphql'),
    ]).toEqual([0, 0, 0])
    const downloaded = (await repo.log())
      .filter(([route]) => route === 'raw')
      .map(([, raw]) => raw.slice(raw.indexOf('/') + 1))
    expect(new Set(downloaded)).toEqual(new Set(Object.keys(REPO)))
  })

  it('does not search a scope cheaper to read', async () => {
    scope.warn = 100
    const line = 'grep -rw import /gh'
    const got = await onGithub(line)
    expect(got).toEqual(await run(ram(), line))
    expect(await repo.count('search')).toBe(0)
  })

  // Twin of test_a_search_past_the_scope_cap_stops_there.
  it.each([
    ['grep -r import /gh', 'grep'],
    ['grep -rwv import /gh', 'grep'],
    ["rg 'imp.rt' /gh", 'rg'],
  ])('stops %s past the scope cap', async (line, name) => {
    const got = await onGithub(line, { walkLimit: 4 })
    expect(got).toEqual(await run(ram(), line, 4))
    expect(got.slice(1)).toEqual([`${name}: /gh: ${STOPPED_AT_4}`, 2])
    expect(await repo.count('blob')).toBe(4)
  })

  // Twin of test_a_tree_diff_past_the_scope_cap_is_refused.
  it('refuses a tree diff past the scope cap', async () => {
    const got = await onGithub('diff -r /gh /gh', { walkLimit: 4 })
    expect(got).toEqual(['', `diff: ${REFUSED_AT_4}`, 1])
    expect(await repo.count('blob')).toBe(0)
  })

  // Twin of test_an_archive_past_the_scope_cap_is_refused.
  it('refuses an archive past the scope cap', async () => {
    const got = await onGithub('tar -cf - /gh/src', { walkLimit: 1 })
    expect(got).toEqual(['', 'tar: more than 1 files in scope (walk_limit); narrow the path\n', 1])
    expect(await repo.count('blob')).toBe(0)
  })

  // [mount prefix, scope below it, files in scope]
  it.each<[string, string, number]>([
    ['/gh', '', 5],
    ['/gh', '/docs', 3],
    ['/r/gh', '', 5],
  ])('counts the refetched tree after an expiry at %s%s', async (prefix, sub, count) => {
    // One under the refetched count: a count off the expired tree is smaller,
    // and would let the walk run.
    await repo.create({ 'docs/a.txt': 'a', 'docs/b.txt': 'b', 'top.txt': 't' })
    const vfs = await mounted()
    const commandLimits = { [ALL_COMMANDS]: new Limit({ walkLimit: count - 1 }) }
    const ws = new Workspace(
      { [prefix]: new Mount(vfs, { mode: MountMode.READ, commandLimits }) },
      {},
    )
    try {
      expect((await ws.shell(`ls ${prefix}/docs`)).exitCode).toBe(0)
      await repo.commit({ 'docs/c.txt': 'c', 'new/d.txt': 'd' })
      await ws.registry.mountFor(prefix).index.invalidate()
      await repo.run.recordRequests()
      const target = `${prefix}${sub}`
      const result = await ws.shell(`diff -r ${target} ${target}`)
      expect(DEC.decode(result.stderr)).toBe(
        `diff: more than ${String(count - 1)} files in scope (walk_limit); narrow the path\n`,
      )
      expect(await repo.counts()).toEqual([0, 1, 0])
    } finally {
      await ws.close()
    }
  })

  // Twin of test_a_narrowed_search_under_the_scope_cap_runs: code search
  // names three files, so a cap of four reads them all.
  it.each(['grep -rw import /gh', 'grep -rwa import /gh', 'rg -w --binary import /gh'])(
    'runs %s, narrowed under the scope cap',
    async (line) => {
      const got = await onGithub(line, { walkLimit: 4 })
      expect(got).toEqual(await run(ram(), line))
      expect(await read()).toEqual(['big.txt', 'docs/c.md', 'src/a.py'])
    },
  )

  // Code search never indexes a big file, so the answer names it; the walk
  // skips a binary extension without -a, so it is not a read to cap.
  it('does not count a binary the walk skips toward the cap', async () => {
    const weights = { 'w0.bin': REPO['big.txt'] ?? '', 'w1.bin': REPO['big.txt'] ?? '' }
    const line = 'grep -rw import /gh'
    const got = await onGithub(line, { files: { ...REPO, ...weights }, walkLimit: 3 })
    expect(got).toEqual(await run(ram(), line))
    expect(await repo.count('search')).toBe(1)
  })

  // Twin of test_a_narrowed_search_past_the_scope_cap_stops_there.
  it('stops a narrowed search past the scope cap', async () => {
    const got = await onGithub('grep -rw import /gh', { walkLimit: 2 })
    expect(got).toEqual([
      '/gh/big.txt:import\n',
      'grep: /gh: stopped after 2 files (walk_limit); narrow the path\n',
      2,
    ])
    expect(await read()).toEqual(['big.txt', 'docs/c.md'])
  })
})
