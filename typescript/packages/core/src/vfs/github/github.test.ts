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
import type * as Constants from '../../core/github/constants.ts'

const scope = vi.hoisted(() => ({ warn: 1, error: 5000 }))

vi.mock('../../core/github/constants.ts', async () => {
  const actual = await vi.importActual<typeof Constants>('../../core/github/constants.ts')
  return {
    ...actual,
    get SCOPE_WARN(): number {
      return scope.warn
    },
    get SCOPE_ERROR(): number {
      return scope.error
    },
  }
})

import { blobSha, FakeGitHub } from '../../core/github/_test_util.ts'
import { MountMode } from '../../types.ts'
import { getTestParser } from '../../workspace/fixtures/workspace_fixture.ts'
import { Mount } from '../../workspace/mount/spec.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { RAMVFS } from '../ram/ram.ts'
import { GitHubVFS } from './github.ts'

const DEC = new TextDecoder()
const TREE = [
  { path: 'top.txt', type: 'blob', sha: 'a', size: 2 },
  { path: 'empty', type: 'tree', sha: 'b' },
]

function offline(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input)
      const body = url.includes('/git/trees/')
        ? { tree: TREE, truncated: false }
        : { default_branch: 'main' }
      return Promise.resolve(
        new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }),
      )
    }),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('GitHubVFS', () => {
  for (const [mode, refusal] of [
    [MountMode.READ, 'Read-only file system'],
    [MountMode.WRITE, 'Operation not supported'],
  ] as const) {
    it(`refuses removing a tree entry on a ${mode} mount rather than missing it`, async () => {
      // rm, rmdir and unlink stat their operand first; a file `ls` lists
      // must meet the mount's refusal, -f or not, as GNU's does on a
      // filesystem that refuses the removal. Mirrors the Python test.
      offline()
      const vfs = await GitHubVFS.create({
        token: 't',
        owner: 'o',
        repo: 'r',
        ref: 'main',
        baseUrl: 'http://127.0.0.1:1',
      })
      const ws = new Workspace({ '/gh': vfs }, { mode, shellParser: await getTestParser() })
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

async function run(vfs: GitHubVFS | RAMVFS, line: string): Promise<Ran> {
  const ws = new Workspace(
    { '/gh': new Mount(vfs, { mode: MountMode.READ }) },
    { shellParser: await getTestParser() },
  )
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

async function onGithub(
  line: string,
  hub = new FakeGitHub(REPO),
  pinned = false,
): Promise<[Ran, FakeGitHub]> {
  vi.stubGlobal('fetch', hub.fetch)
  const ref = pinned ? { ref: await hub.head() } : {}
  const vfs = await GitHubVFS.create({
    token: 't',
    owner: 'o',
    repo: 'r',
    baseUrl: hub.url,
    ...ref,
  })
  hub.log.length = 0
  return [await run(vfs, line), hub]
}

async function read(hub: FakeGitHub): Promise<string[]> {
  const names = new Map<string, string>()
  for (const [path, data] of Object.entries(REPO)) names.set(await blobSha(data), path)
  return hub.log
    .filter(([route]) => route === 'blob')
    .map(([, sha]) => names.get(sha) ?? sha)
    .sort()
}

describe('grep and rg over code search', () => {
  beforeEach(() => {
    scope.warn = 1
    scope.error = 5000
  })

  afterEach(() => {
    vi.unstubAllGlobals()
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
    const [got, hub] = await onGithub(line)
    expect(got).toEqual(await run(ram(), line))
    expect(hub.count('search')).toBe(1)
    expect(await read(hub)).toEqual(files)
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
    const [got, hub] = await onGithub(line)
    expect(got).toEqual(await run(ram(), line))
    expect(hub.count('search')).toBe(0)
  })

  // A truncated tree cannot list the files code search never indexes.
  it.each(['failed', 'truncated-tree'])('a %s search reads every file', async (kind) => {
    const hub = new FakeGitHub(REPO)
    if (kind === 'failed') hub.fail.set('search', [500, 'boom'])
    else hub.truncatedRecursive = true
    const line = 'grep -rw import /gh'
    const [got] = await onGithub(line, hub)
    expect(got).toEqual(await run(ram(), line))
    expect(await read(hub)).toEqual(Object.keys(REPO).sort())
  })

  // Code search indexes the default branch only, so a mount pinned to a
  // commit reads every file as a plain scan does.
  it('reads every file off the default branch', async () => {
    const line = 'grep -rw import /gh'
    const [got, hub] = await onGithub(line, new FakeGitHub(REPO), true)
    expect(got).toEqual(await run(ram(), line))
    expect(hub.count('search')).toBe(0)
    expect(await read(hub)).toEqual(Object.keys(REPO).sort())
  })

  it('refuses off the default branch without the -w hint', async () => {
    scope.error = 4
    const [got] = await onGithub('grep -rw import /gh', new FakeGitHub(REPO), true)
    expect(got).toEqual(['', 'grep: 5 files in scope, narrow the path\n', 1])
  })

  it('does not search a scope cheaper to read', async () => {
    scope.warn = 100
    const line = 'grep -rw import /gh'
    const [got, hub] = await onGithub(line)
    expect(got).toEqual(await run(ram(), line))
    expect(hub.count('search')).toBe(0)
  })

  it.each([
    [
      'grep -r import /gh',
      'grep: 5 files in scope and code search could not narrow them; narrow the path, or search a whole word with -w\n',
    ],
    ['grep -rwv import /gh', 'grep: 5 files in scope, narrow the path\n'],
    ['grep -rwa import /gh', 'grep: 5 files in scope, narrow the path\n'],
    ['rg -w --binary import /gh', 'rg: 5 files in scope, narrow the path\n'],
    [
      "rg 'imp.rt' /gh",
      'rg: 5 files in scope and code search could not narrow them; narrow the path, or search a whole word with -w\n',
    ],
  ])('refuses %s past the scope cap', async (line, stderr) => {
    scope.error = 4
    const [got, hub] = await onGithub(line)
    expect(got).toEqual(['', stderr, 1])
    expect(hub.count('blob')).toBe(0)
  })

  // [mount prefix, scope below it, files in scope]
  it.each<[string, string, number]>([
    ['/gh', '', 5],
    ['/gh', '/docs', 3],
    ['/r/gh', '', 5],
  ])('counts the refetched tree after an expiry at %s%s', async (prefix, sub, count) => {
    scope.error = 0
    const hub = new FakeGitHub({ 'docs/a.txt': 'a', 'docs/b.txt': 'b', 'top.txt': 't' })
    vi.stubGlobal('fetch', hub.fetch)
    const vfs = await GitHubVFS.create({ token: 't', owner: 'o', repo: 'r', baseUrl: hub.url })
    const ws = new Workspace(
      { [prefix]: new Mount(vfs, { mode: MountMode.READ }) },
      { shellParser: await getTestParser() },
    )
    try {
      expect((await ws.shell(`ls ${prefix}/docs`)).exitCode).toBe(0)
      hub.set('docs/c.txt', 'c')
      hub.set('new/d.txt', 'd')
      await ws.registry.mountFor(prefix).index.invalidate()
      hub.log.length = 0
      const result = await ws.shell(`grep -rv x ${prefix}${sub}`)
      expect(DEC.decode(result.stderr)).toBe(
        `grep: ${String(count)} files in scope, narrow the path\n`,
      )
      expect(hub.counts()).toEqual([0, 1, 0])
    } finally {
      await ws.close()
    }
  })

  it('does not refuse a narrowed scan', async () => {
    scope.error = 4
    const line = 'grep -rw import /gh'
    const [got] = await onGithub(line)
    expect(got).toEqual(await run(ram(), line))
  })

  // Code search never indexes a big file, so the answer names it; the walk
  // skips a binary extension without -a, so it is not a read to cap.
  it('does not count a binary the walk skips toward the cap', async () => {
    scope.error = 3
    const weights = { 'w0.bin': REPO['big.txt'] ?? '', 'w1.bin': REPO['big.txt'] ?? '' }
    const line = 'grep -rw import /gh'
    const [got, hub] = await onGithub(line, new FakeGitHub({ ...REPO, ...weights }))
    expect(got).toEqual(await run(ram(), line))
    expect(hub.count('search')).toBe(1)
  })

  it('refuses a narrowed scan past the scope cap', async () => {
    scope.error = 2
    const [got, hub] = await onGithub('grep -rw import /gh')
    expect(got).toEqual([
      '',
      'grep: 3 files in scope and code search could not narrow them; narrow the path\n',
      1,
    ])
    expect(hub.count('blob')).toBe(0)
  })
})
