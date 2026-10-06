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

import { searchConformance } from './search_conformance.ts'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type { ChildProcessByStdio } from 'node:child_process'
import { dirname, join, relative, resolve, sep } from 'node:path'
import type { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { ANNOUNCE_RE } from '../kit/typescript/announce.ts'
import type { JsonValue } from '../kit/typescript/types.ts'
import { start } from '../kit/typescript/serve.ts'
import { diffTrees, unifiedDiff } from './diff.ts'
import { githubFake } from './fake.ts'
import { blobSha } from './wire.ts'
import { PrismaClient } from '../../generated/github/index.js'
import { directoryIds, repoByName, stageTree, subtreeOf, treeById } from './store.ts'

// The routes the corpus does not reach, or cannot exercise fully, because the
// gh battery drives the porcelain against a one-repository fixture. A client
// that BUILDS history calls `POST /git/trees` then `POST /git/commits`, which is
// the path a fixture uses to pin a commit's own author and date; a grader reads
// an issue's comments back; repository search must preserve owner scope;
// and code search's scope rules need files under several owners and a
// mixed-case name, which the `cli` fixture does not hold.

const HERE = dirname(fileURLToPath(import.meta.url))
const INTEG = resolve(HERE, '..', '..')
const TENANT = 'selftest-github'
const REPO = 'integ/repo-v1'

let checks = 0

function check(name: string, ok: boolean, detail = ''): void {
  checks += 1
  const line = `  ${ok ? 'ok  ' : 'FAIL'} ${String(checks).padStart(2, '0')} ${name}`
  process.stdout.write(detail === '' ? `${line}\n` : `${line}  [${detail}]\n`)
  if (!ok) throw new Error(`github selftest failed: ${name} ${detail}`)
}

function eq(name: string, got: JsonValue, want: JsonValue): void {
  const a = JSON.stringify(got)
  const b = JSON.stringify(want)
  check(name, a === b, a === b ? a : `got ${a} want ${b}`)
}

interface Fake {
  child: ChildProcessByStdio<null, Readable, Readable>
  endpoint: string
}

async function launch(): Promise<Fake> {
  const child = spawn(
    join(INTEG, 'node_modules', '.bin', 'tsx'),
    [join(HERE, 'main.ts'), '--port', '0'],
    { cwd: INTEG, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } },
  )
  let err = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (d: string) => {
    err += d
  })
  const first = await new Promise<string>((ok, bad) => {
    let out = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (d: string) => {
      out += d
      const nl = out.indexOf('\n')
      if (nl !== -1) ok(out.slice(0, nl))
    })
    child.on('exit', (code) => {
      bad(new Error(`fake exited ${String(code)} before announcing\n${err}`))
    })
  })
  check('announce line matches ANNOUNCE_RE', ANNOUNCE_RE.test(first), first)
  return { child, endpoint: first.split('=').slice(1).join('=') }
}

const HEADERS = {
  'x-mirage-tenant': TENANT,
  authorization: 'token integ',
  'content-type': 'application/json',
}

async function post(url: string, body: JsonValue): Promise<{ status: number; body: JsonValue }> {
  const r = await fetch(url, { method: 'POST', headers: HEADERS, body: JSON.stringify(body) })
  return { status: r.status, body: (await r.json()) as JsonValue }
}

async function get(url: string): Promise<JsonValue> {
  const r = await fetch(url, { headers: HEADERS })
  return (await r.json()) as JsonValue
}

async function send(
  method: string,
  url: string,
  body?: JsonValue,
  accept?: string,
): Promise<{ status: number; body: JsonValue; bytes: Buffer; text: string; link: string }> {
  const r = await fetch(url, {
    method,
    headers: { ...HEADERS, ...(accept === undefined ? {} : { accept }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const bytes = Buffer.from(await r.arrayBuffer())
  const text = bytes.toString('utf8')
  const parsed = r.headers.get('content-type')?.includes('json')
    ? (JSON.parse(text) as JsonValue)
    : null
  return { status: r.status, body: parsed, bytes, text, link: r.headers.get('link') ?? '' }
}

function field(body: JsonValue, key: string): JsonValue {
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? ((body as Record<string, JsonValue>)[key] ?? null)
    : null
}

// A refusal is pinned by its status and its message together, because the
// vendor tells an empty repository from a missing ref by both.
async function refusal(url: string): Promise<JsonValue> {
  const r = await fetch(url, { headers: HEADERS })
  return [r.status, field((await r.json()) as JsonValue, 'message')]
}

// Every ref spelling a client might ask an empty repository about: shown or
// listed, branch or tag, one that would exist and one that never could, and
// the bare listing with and without its slash.
const REF_PATHS = [
  'git/ref/heads/main',
  'git/ref/heads/nope',
  'git/ref/tags/v1',
  'git/refs',
  'git/refs/',
  'git/refs/heads',
  'git/refs/heads/main',
  'git/refs/tags',
]

// Object reads an empty repository refuses the same way, measured against
// GitHub (2026-09-27): the recursive and shallow tree of a ref, one directory
// of it, and a blob, here the empty blob every git repository could name.
const OBJECT_PATHS = [
  'git/trees/main?recursive=1',
  'git/trees/main',
  'git/trees/main%3Adocs',
  'git/blobs/e69de29bb2d1d6434b8b29ae775ad8c2e48c5391',
]

// One staged tree holding one file, which is what a commit needs to exist.
async function stage(at: string, path: string, content: string): Promise<string> {
  const tree = await post(`${at}/repos/${REPO}/git/trees`, {
    tree: [{ path, mode: '100644', type: 'blob', content }],
  })
  return String(field(tree.body, 'sha') ?? '')
}

const AUTHOR = { name: 'Dana Wu', email: 'dana@example.com', date: '2025-09-02T09:00:00+08:00' }

async function metadataRepository(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'mirage-empty-repo-'))
  try {
    await mkdir(join(root, 'github'))
    await writeFile(
      join(root, 'github', 'metadata.json'),
      JSON.stringify({
        repos: [
          {
            fullName: 'integ/metadata',
            owner: 'integ',
            name: 'metadata',
            defaultBranch: 'main',
          },
        ],
      }),
    )
    const home = await start(githubFake, 0, 'metadata', root)
    try {
      await home.runtime.reset({ tenants: [TENANT], fixture: 'metadata' })
      for (const prefix of ['', '/api/v3']) {
        const repo = `${home.endpoint}${prefix}/repos/integ/metadata`
        const contents = await fetch(`${repo}/contents/`, { headers: HEADERS })
        eq('metadata-only contents returns 404', contents.status, 404)
        eq(
          'metadata-only contents identifies an empty repository',
          field((await contents.json()) as JsonValue, 'message'),
          'This repository is empty.',
        )
        const commits = await fetch(`${repo}/commits`, { headers: HEADERS })
        eq('metadata-only history returns 409', commits.status, 409)
        eq(
          'metadata-only history identifies an empty repository',
          field((await commits.json()) as JsonValue, 'message'),
          'Git Repository is empty.',
        )
        eq('metadata-only tags list is empty', await get(`${repo}/tags`), [])
        for (const path of [...REF_PATHS, ...OBJECT_PATHS]) {
          eq(`metadata-only ${path} is refused as empty`, await refusal(`${repo}/${path}`), [
            409,
            'Git Repository is empty.',
          ])
        }
        eq(
          'metadata-only contents at an unknown ref is still empty',
          await refusal(`${repo}/contents/?ref=nope`),
          [404, 'This repository is empty.'],
        )
      }
    } finally {
      await home.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function emptyRepository(at: string): Promise<void> {
  const base = `${at}/_run/empty-repository`
  await post(`${base}/reset`, { run: 'empty-repository', tenants: [TENANT], fixture: 'empty' })
  for (const prefix of ['', '/api/v3']) {
    const name = prefix === '' ? 'empty-public' : 'empty-enterprise'
    const created = await post(`${base}${prefix}/user/repos`, { name })
    eq('empty repository creation succeeds', created.status, 201)
    const repo = `${base}${prefix}/repos/integ-user/${name}`
    for (const path of ['contents', 'contents/']) {
      const response = await fetch(`${repo}/${path}`, { headers: HEADERS })
      eq('empty contents returns 404', response.status, 404)
      eq(
        'empty contents explains why',
        field((await response.json()) as JsonValue, 'message'),
        'This repository is empty.',
      )
    }
    // Emptiness is answered before the ref is resolved, so a ref that names
    // nothing is told the repository is empty, not that the ref is missing.
    for (const path of ['contents/?ref=nope', 'contents?ref=nope', 'contents/first.txt?ref=nope']) {
      eq(`empty ${path} is refused as empty`, await refusal(`${repo}/${path}`), [
        404,
        'This repository is empty.',
      ])
    }
    const commits = await fetch(`${repo}/commits`, { headers: HEADERS })
    eq('empty history returns 409', commits.status, 409)
    eq(
      'empty history explains why',
      field((await commits.json()) as JsonValue, 'message'),
      'Git Repository is empty.',
    )
    // GitHub answers an empty repository before it resolves the ref, so a name
    // or sha that matches nothing gets the same 409 as the default branch.
    for (const ref of ['main', 'HEAD', 'nope', 'deadbeef'.repeat(5)]) {
      const one = await fetch(`${repo}/commits/${ref}`, { headers: HEADERS })
      eq(`empty commit ${ref} returns 409`, one.status, 409)
      eq(
        `empty commit ${ref} explains why`,
        field((await one.json()) as JsonValue, 'message'),
        'Git Repository is empty.',
      )
    }
    const tags = await fetch(`${repo}/tags`, { headers: HEADERS })
    eq('empty tags succeeds', tags.status, 200)
    eq('empty tags lists nothing', (await tags.json()) as JsonValue, [])
    // The fake lets a branch be cut from nothing here. It holds no commit, so
    // the repository stays empty, and once another branch has history it is
    // still no ref: every read of it below is refused.
    const cut = await post(`${repo}/git/refs`, { ref: 'refs/heads/side', sha: '' })
    eq('a branch cut from nothing is created', cut.status, 201)
    eq('and leaves the repository empty', await refusal(`${repo}/contents/?ref=side`), [
      404,
      'This repository is empty.',
    ])
    for (const path of [...REF_PATHS, ...OBJECT_PATHS]) {
      eq(`empty ${path} is refused as empty`, await refusal(`${repo}/${path}`), [
        409,
        'Git Repository is empty.',
      ])
    }
    const written = await fetch(`${repo}/contents/first.txt`, {
      method: 'PUT',
      headers: HEADERS,
      body: JSON.stringify({
        message: 'First real commit',
        content: Buffer.from('hello').toString('base64'),
      }),
    })
    eq('first write succeeds', written.status, 201)
    const body = (await written.json()) as JsonValue
    const history = (await get(`${repo}/commits`)) as JsonValue[]
    eq('first write has no invented ancestor', history.length, 1)
    eq(
      'history contains the written commit',
      field(history[0] ?? null, 'sha'),
      field(field(body, 'commit'), 'sha'),
    )
    // One write and the repository has a ref, so refs resolve again: the
    // branch points at the commit the write made, and a ref, a commit or a
    // contents ref that names nothing is refused as missing, not as empty.
    const sha = field(field(body, 'commit'), 'sha')
    eq('the written branch shows its ref', await get(`${repo}/git/ref/heads/main`), {
      ref: 'refs/heads/main',
      object: { sha, type: 'commit' },
    })
    for (const path of ['git/refs', 'git/refs/heads']) {
      eq(`${path} lists the written branch`, await get(`${repo}/${path}`), [
        { ref: 'refs/heads/main', object: { sha, type: 'commit' } },
      ])
    }
    eq('an unknown ref is missing, not empty', await refusal(`${repo}/git/ref/heads/nope`), [
      404,
      'Not Found',
    ])
    for (const ref of ['nope', 'refs/heads/nope', 'deadbeef'.repeat(5)]) {
      eq(`an unknown commit ${ref} is refused by name`, await refusal(`${repo}/commits/${ref}`), [
        422,
        `No commit found for SHA: ${ref}`,
      ])
    }
    eq('contents at an unknown ref names it', await refusal(`${repo}/contents/?ref=nope`), [
      404,
      'No commit found for the ref nope',
    ])
    // The listings above already leave `side` out.
    eq('an uncommitted branch has no contents', await refusal(`${repo}/contents/?ref=side`), [
      404,
      'No commit found for the ref side',
    ])
    eq('nor a ref', await refusal(`${repo}/git/ref/heads/side`), [404, 'Not Found'])
    eq('nor a commit', await refusal(`${repo}/commits/side`), [
      422,
      'No commit found for SHA: side',
    ])
    const deleted = await fetch(`${repo}/contents/first.txt`, {
      method: 'DELETE',
      headers: HEADERS,
      body: JSON.stringify({
        message: 'Remove last file',
        sha: field(field(body, 'content'), 'sha'),
      }),
    })
    eq('last file deletion succeeds', deleted.status, 200)
    eq(
      'a committed empty tree still has history',
      ((await get(`${repo}/commits`)) as JsonValue[]).length,
      2,
    )
    eq('a committed empty tree lists successfully', await get(`${repo}/contents/`), [])
    eq(
      'a committed empty tree still shows its ref',
      field(field(await get(`${repo}/git/ref/heads/main`), 'object'), 'sha'),
      field(field((await deleted.json()) as JsonValue, 'commit'), 'sha'),
    )
  }
  for (const path of ['/graphql', '/api/graphql']) {
    const response = await post(`${base}${path}`, { query: '{ viewer { login } }' })
    eq('GraphQL endpoint succeeds', response.status, 200)
    eq('GraphQL endpoint resolves viewer', field(response.body, 'data'), {
      viewer: { login: 'integ-user' },
    })
    const anonymous = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{ viewer { login } }' }),
    })
    eq('GraphQL requires authentication', anonymous.status, 401)
  }
}

// A seeded branch has files and no commit, so its ref answers with a root
// derived from those files. The first change on it, a write or a delete, names
// that root as its parent, and history has to keep listing it under that
// commit however the files change afterwards.
async function seededHistory(at: string): Promise<void> {
  for (const first of ['PUT', 'DELETE']) {
    const run = `seeded-${first.toLowerCase()}`
    const base = `${at}/_run/${run}`
    await post(`${base}/reset`, { run, tenants: [TENANT], fixture: 'v1' })
    const repo = `${base}/repos/${REPO}`
    const root = String(field(field(await get(`${repo}/git/ref/heads/main`), 'object'), 'sha'))
    eq('a seeded branch is not an empty repository', await refusal(`${repo}/commits/nope`), [
      422,
      'No commit found for SHA: nope',
    ])
    const path = first === 'PUT' ? 'first.txt' : 'README.md'
    const change =
      first === 'PUT'
        ? { message: 'First change', content: Buffer.from('one').toString('base64') }
        : { message: 'First change', sha: field(await get(`${repo}/contents/${path}`), 'sha') }
    const changed = await fetch(`${repo}/contents/${path}`, {
      method: first,
      headers: HEADERS,
      body: JSON.stringify(change),
    })
    eq(`a first ${first} on a seeded branch succeeds`, changed.status, first === 'PUT' ? 201 : 200)
    const second = await fetch(`${repo}/contents/second.txt`, {
      method: 'PUT',
      headers: HEADERS,
      body: JSON.stringify({
        message: 'Second change',
        content: Buffer.from('two').toString('base64'),
      }),
    })
    eq('a second write on it succeeds', second.status, 201)
    const history = (await get(`${repo}/commits`)) as JsonValue[]
    eq(
      'history lists both changes above one root',
      history.map((c) => field(field(c, 'commit'), 'message')),
      ['Second change', 'First change', 'Initial commit'],
    )
    eq(
      'that root is where the ref pointed before the first change',
      field(history[2] ?? null, 'sha'),
      root,
    )
    const found = field(
      await get(`${base}/search/commits?q=${encodeURIComponent(`repo:${REPO} first change`)}`),
      'items',
    ) as JsonValue[]
    eq(
      'the first change names that root as its parent',
      (field(found[0] ?? null, 'parents') as JsonValue[]).map((p) => field(p, 'sha')),
      [root],
    )
    const resolved = await fetch(`${repo}/git/commits/${root}`, { headers: HEADERS })
    eq('that root still resolves as a commit', resolved.status, 200)
    const compared = await fetch(`${repo}/compare/${root}...main`, { headers: HEADERS })
    eq('a comparison from that root succeeds', compared.status, 200)
    eq(
      'and reports both changes',
      ((field((await compared.json()) as JsonValue, 'files') ?? []) as JsonValue[]).map((f) =>
        field(f, 'filename'),
      ),
      [path, 'second.txt'],
    )
  }
}

// Git keeps an object once it is written, so a blob sha an old listing named
// still reads its own bytes after its path changes: overwritten or deleted,
// whether the bytes came from the seed or from a commit. Measured against
// GitHub (2026-09-27): a superseded blob answers 200 with its old bytes.
async function supersededBlobs(at: string): Promise<void> {
  const run = 'superseded-blobs'
  const base = `${at}/_run/${run}`
  await post(`${base}/reset`, { run, tenants: [TENANT], fixture: 'v1' })
  const repo = `${base}/repos/${REPO}`
  const send = async (method: string, body: JsonValue): Promise<JsonValue> => {
    const r = await fetch(`${repo}/contents/README.md`, {
      method,
      headers: HEADERS,
      body: JSON.stringify(body),
    })
    eq(`the ${method} of README.md succeeds`, r.status, 200)
    return (await r.json()) as JsonValue
  }
  const blob = async (sha: JsonValue): Promise<JsonValue> => {
    const r = await fetch(`${repo}/git/blobs/${String(sha)}`, { headers: HEADERS })
    if (r.status !== 200) return r.status
    return Buffer.from(String(field((await r.json()) as JsonValue, 'content')), 'base64').toString()
  }
  const seeded = await get(`${repo}/contents/README.md`)
  const seededText = Buffer.from(String(field(seeded, 'content')), 'base64').toString()
  const one = await send('PUT', {
    message: 'Replace the seed',
    content: Buffer.from('one').toString('base64'),
    sha: field(seeded, 'sha'),
  })
  eq('a seeded blob a write replaced still reads', await blob(field(seeded, 'sha')), seededText)
  const oneSha = field(field(one, 'content'), 'sha')
  const two = await send('PUT', {
    message: 'Replace the commit',
    content: Buffer.from('two').toString('base64'),
    sha: oneSha,
  })
  eq('a committed blob a write replaced still reads', await blob(oneSha), 'one')
  const twoSha = field(field(two, 'content'), 'sha')
  await send('DELETE', { message: 'Remove it', sha: twoSha })
  eq('a deleted blob still reads', await blob(twoSha), 'two')
  eq('a sha no tree ever held is not found', await blob('0'.repeat(40)), 404)
}

// A ref names a branch, or one commit by its full or abbreviated sha, and
// every read that takes one answers from what it names: a commit's own
// files, its own history, its own place in a comparison.
async function refsNameCommits(at: string): Promise<void> {
  const run = 'refs-name-commits'
  const base = `${at}/_run/${run}`
  await post(`${base}/reset`, { run, tenants: [TENANT], fixture: 'v1' })
  const repo = `${base}/repos/${REPO}`
  const status = async (url: string, init: RequestInit = {}): Promise<number> =>
    (await fetch(url, { headers: HEADERS, ...init })).status
  const put = await fetch(`${repo}/contents/later.txt`, {
    method: 'PUT',
    headers: HEADERS,
    body: JSON.stringify({ message: 'Later', content: Buffer.from('later').toString('base64') }),
  })
  eq('a file lands on the seeded branch', put.status, 201)
  const history = (await get(`${repo}/commits`)) as JsonValue[]
  const head = String(field(history[0] ?? null, 'sha'))
  const root = String(field(history.at(-1) ?? null, 'sha'))
  eq(
    'four hex digits name the root',
    field(await get(`${repo}/commits/${root.slice(0, 4)}`), 'sha'),
    root,
  )
  eq('three name nothing', await status(`${repo}/commits/${root.slice(0, 3)}`), 422)
  eq(
    'commits?sha= lists from the commit it names',
    ((await get(`${repo}/commits?sha=${root.slice(0, 7).toUpperCase()}`)) as JsonValue[]).map((c) =>
      field(c, 'sha'),
    ),
    [root],
  )
  eq('commits?sha= naming nothing is 404', await status(`${repo}/commits?sha=0000000`), 404)
  eq(
    'the root reads its own files',
    await status(`${repo}/contents/later.txt?ref=${root.slice(0, 7)}`),
    404,
  )
  eq(
    'the head reads its own',
    await status(`${repo}/contents/later.txt?ref=${head.slice(0, 7)}`),
    200,
  )
  const paths = async (ref: string): Promise<boolean> =>
    ((field(await get(`${repo}/git/trees/${ref}?recursive=1`), 'tree') as JsonValue[]) ?? []).some(
      (row) => field(row, 'path') === 'later.txt',
    )
  eq("a tree by the root's short sha is the root's", await paths(root.slice(0, 7)), false)
  eq("a tree by the head's short sha is the head's", await paths(head.slice(0, 7)), true)
  const compare = async (spec: string): Promise<JsonValue> => {
    const body = await get(`${repo}/compare/${spec}`)
    return [field(body, 'status'), field(body, 'ahead_by'), field(body, 'behind_by')]
  }
  eq('the head is ahead of the root', await compare(`${root.slice(0, 7)}...main`), ['ahead', 1, 0])
  eq('the root is behind the head', await compare(`main...${root.slice(0, 7)}`), ['behind', 0, 1])
  eq('a branch is identical to itself', await compare('main...main'), ['identical', 0, 0])
  const made = await post(`${repo}/git/refs`, { ref: 'refs/heads/old', sha: root.slice(0, 7) })
  eq('a branch starts at a short sha', made.status, 201)
  eq("and holds that commit's files", await status(`${repo}/contents/later.txt?ref=old`), 404)
}

// A seeded branch force-moved onto an unrelated root leaves its own root on
// no branch, and that sha still names its commit and its files, as git keeps
// an object once it exists.
async function abandonedRoot(at: string): Promise<void> {
  const run = 'abandoned-root'
  const base = `${at}/_run/${run}`
  await post(`${base}/reset`, { run, tenants: [TENANT], fixture: 'v1' })
  const repo = `${base}/repos/${REPO}`
  const root = String(field(((await get(`${repo}/commits`)) as JsonValue[])[0] ?? null, 'sha'))
  const tree = await post(`${repo}/git/trees`, {
    tree: [{ path: 'only.txt', mode: '100644', type: 'blob', content: 'only' }],
  })
  const other = await post(`${repo}/git/commits`, {
    message: 'Unrelated',
    tree: field(tree.body, 'sha'),
    parents: [],
  })
  const moved = await fetch(`${repo}/git/refs/heads/main`, {
    method: 'PATCH',
    headers: HEADERS,
    body: JSON.stringify({ sha: field(other.body, 'sha'), force: true }),
  })
  eq('the branch is forced onto an unrelated root', moved.status, 200)
  eq(
    'the old root still names its commit',
    field(await get(`${repo}/commits/${root.slice(0, 7)}`), 'sha'),
    root,
  )
  const readme = await fetch(`${repo}/contents/README.md?ref=${root.slice(0, 7)}`, {
    headers: HEADERS,
  })
  eq('and its files', readme.status, 200)
  const dispatch = await fetch(
    `${base}/repos/integ/repo-cli/actions/workflows/archive.yml/dispatches`,
    {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ ref: 'main' }),
    },
  )
  eq('a disabled workflow is not dispatched', await refusalOf(dispatch), [
    422,
    "Cannot trigger a 'workflow_dispatch' on a disabled workflow",
  ])
}

async function refusalOf(r: Response): Promise<JsonValue> {
  return [r.status, field((await r.json()) as JsonValue, 'message')]
}

// Workflows are the repository's files, and the settings routes store what
// they take and refuse what they do not, before anything is written.
async function workflowsAndSettings(at: string): Promise<void> {
  const run = 'workflows-and-settings'
  const base = `${at}/_run/${run}`
  await post(`${base}/reset`, { run, tenants: [TENANT], fixture: 'v1' })
  const repo = `${base}/repos/${REPO}`
  const send = async (method: string, path: string, body?: JsonValue): Promise<number> =>
    (
      await fetch(`${repo}${path}`, {
        method,
        headers: HEADERS,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    ).status
  const write = (path: string, text: string): Promise<number> =>
    send('PUT', `/contents/${path}`, {
      message: `Add ${path}`,
      content: Buffer.from(text).toString('base64'),
    })
  await write('.github/workflows/nameless.yaml', 'on: push\n')
  await write('.github/workflows/nested/deep.yml', 'name: Deep\n')
  await write('.github/workflows/notes.txt', 'name: Notes\n')
  const listed = async (): Promise<JsonValue> =>
    ((field(await get(`${repo}/actions/workflows`), 'workflows') as JsonValue[]) ?? []).map((w) => [
      field(w, 'name'),
      field(w, 'path'),
    ])
  eq('the list is the workflow files, by id', await listed(), [
    ['Archive', '.github/workflows/archive.yml'],
    ['CI', '.github/workflows/ci.yml'],
    ['.github/workflows/nameless.yaml', '.github/workflows/nameless.yaml'],
  ])
  eq('a workflow is found by its file', await send('GET', '/actions/workflows/ci.yml'), 200)
  eq('never by its display name', await send('GET', '/actions/workflows/CI'), 404)
  eq(
    'one with no dispatch trigger cannot be dispatched',
    await send('POST', '/actions/workflows/nameless.yaml/dispatches', { ref: 'main' }),
    422,
  )
  eq(
    'a dispatch to a ref that is no branch is refused',
    await send('POST', '/actions/workflows/ci.yml/dispatches', { ref: 'nope' }),
    422,
  )
  const ci = await get(`${repo}/contents/.github/workflows/ci.yml`)
  await send('DELETE', '/contents/.github/workflows/ci.yml', {
    message: 'rm',
    sha: field(ci, 'sha'),
  })
  eq('a workflow whose file is gone is not listed', ((await listed()) as JsonValue[]).length, 2)
  eq(
    'and cannot be dispatched',
    await send('POST', '/actions/workflows/ci.yml/dispatches', { ref: 'main' }),
    404,
  )
  eq(
    'a wrongly typed setting refuses the whole edit',
    await send('PATCH', '', { description: 'x', has_issues: 'yes' }),
    422,
  )
  eq('and writes none of it', field(await get(repo), 'description'), null)
  for (const key of ['name', 'default_branch']) {
    for (const value of [123, null, [], {}]) {
      eq(
        `a wrongly typed ${key} refuses the whole edit`,
        await send('PATCH', '', { description: 'must not land', [key]: value }),
        422,
      )
      eq('the refused edit preserves the repository', field(await get(repo), 'description'), null)
    }
  }
  eq(
    'an invalid branch type cannot partially rename a repository',
    await send('PATCH', '', { name: 'must-not-rename', default_branch: false }),
    422,
  )
  eq('the original name still resolves', await send('GET', ''), 200)
  eq('an unknown visibility is refused', await send('PATCH', '', { visibility: 'secret' }), 422)
  eq('a legacy site needs a source', await send('POST', '/pages', {}), 422)
  eq(
    'a source path is the root or /docs',
    await send('POST', '/pages', { source: { branch: 'main', path: '/site' } }),
    422,
  )
  eq('no site is updated', await send('PUT', '/pages', { cname: null }), 404)
  eq('no site is deleted', await send('DELETE', '/pages'), 404)
  eq(
    'a workflow site needs no source',
    await send('POST', '/pages', { build_type: 'workflow' }),
    201,
  )
  eq("and publishes the default branch's root", field(await get(`${repo}/pages`), 'source'), {
    branch: 'main',
    path: '/',
  })
  eq(
    'a wrongly typed site edit is refused',
    await send('PUT', '/pages', { https_enforced: 'yes' }),
    422,
  )
  const logs = await fetch(`${base}/repos/integ/repo-cli/actions/runs/201/logs`, {
    headers: HEADERS,
  })
  eq("a completed run's logs are a zip", logs.headers.get('content-type'), 'application/zip')
  eq(
    "one job's log is its steps' text",
    (
      await (
        await fetch(`${base}/repos/integ/repo-cli/actions/jobs/401/logs`, { headers: HEADERS })
      ).text()
    ).split('\n')[0] ?? '',
    "2026-01-01T00:00:05.0000000Z Current runner version: '2.330.0'",
  )
}

// Every file under a fixture directory, by its path in the repository, the
// way seeding reads it: the submodule manifest is no file.
async function fixtureTree(dir: string): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>()
  const root = join(INTEG, 'fixtures', dir)
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const path = relative(root, join(entry.parentPath, entry.name)).split(sep).join('/')
    if (path !== 'SUBMODULES') out.set(path, await readFile(join(root, path)))
  }
  return out
}

// `git diff` itself over two trees, with no configuration of the machine it
// runs on, which is the text GitHub serves as a diff. Renames are git's exact
// ones only: a file moved and edited is a removal and an addition here, where
// git would pair the two once they are half alike. Auto maintenance is off: a
// commit starts it detached, and its lock in .git races the cleanup.
async function gitDiff(before: Map<string, Buffer>, after: Map<string, Buffer>): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'gh-diff-'))
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'maintenance.auto',
    GIT_CONFIG_VALUE_0: 'false',
  }
  const git = (...args: string[]): Promise<Buffer> =>
    new Promise((ok, bad) => {
      const child = spawn('git', ['-C', dir, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
      const out: Buffer[] = []
      child.stdout.on('data', (d: Buffer) => out.push(d))
      child.on('error', bad)
      child.on('close', (code) =>
        code === 0 ? ok(Buffer.concat(out)) : bad(new Error(`git ${args[0]} ${code}`)),
      )
    })
  const commit = async (tree: Map<string, Buffer>, message: string): Promise<void> => {
    await git('rm', '-rq', '--ignore-unmatch', '.')
    for (const [path, data] of tree) {
      await mkdir(dirname(join(dir, path)), { recursive: true })
      await writeFile(join(dir, path), data)
    }
    await git('add', '-A')
    await git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', message)
  }
  try {
    await git('init', '-q')
    await commit(before, 'before')
    await commit(after, 'after')
    return await git('diff', '-M100%', 'HEAD~1', 'HEAD')
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 })
  }
}

// Seeded random tree pairs, each diffed by the fake and by git: a small
// vocabulary, so lines repeat and a change can sit in several places, a line
// in Latin-1 that is no UTF-8, names that git quotes or pads, a binary, an
// empty file, a moved file, and last lines with and without their newline.
// Every pair must read as git prints it, byte for byte, which is what pins
// the choice among equally short diffs to git's.
async function diffsMatchGit(): Promise<void> {
  let seed = 7
  const rand = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)] as T
  const words = [
    'def main():',
    '    return 1',
    '',
    '}',
    'class A:',
    '  x',
    'foo',
    '$var',
    '_p',
    '\u00e9t\u00e9',
  ]
  const text = (): string => {
    const lines = Array.from({ length: Math.floor(rand() * 30) }, () => pick(words))
    return lines.length > 0 && rand() < 0.85 ? `${lines.join('\n')}\n` : lines.join('\n')
  }
  const edit = (was: string): string => {
    const lines = was.split('\n')
    for (let k = 1 + Math.floor(rand() * 5); k > 0; k -= 1) {
      const at = Math.floor(rand() * (lines.length + 1))
      const r = rand()
      if (r < 0.33) lines.splice(at, 0, pick(words))
      else if (r < 0.66) lines.splice(at, 1)
      else lines[at] = pick(words)
    }
    return lines.join('\n')
  }
  const names = ['a.txt', 'b/c.py', 'b/d e.md', 'q"t.txt', 'caf\u00e9.txt', 'bin.dat', 'empty.txt']
  const differ: number[] = []
  for (let run = 0; run < 40; run += 1) {
    const before = new Map<string, Buffer>()
    for (const name of names) {
      if (rand() >= 0.7) continue
      const body = name === 'bin.dat' ? `x\0${text()}` : name === 'empty.txt' ? '' : text()
      before.set(name, Buffer.from(body, 'latin1'))
    }
    const after = new Map<string, Buffer>()
    for (const [path, data] of before) {
      const r = rand()
      if (r < 0.15) continue
      if (r < 0.25) after.set(`moved/${path.split('/').pop() ?? path}`, data)
      else if (path === 'bin.dat' || path === 'empty.txt') after.set(path, data)
      else after.set(path, Buffer.from(edit(data.toString('latin1')), 'latin1'))
    }
    const theirs = await gitDiff(before, after)
    if (!unifiedDiff(diffTrees(before, after)).equals(theirs)) differ.push(run)
  }
  eq('forty random tree pairs diff as git diffs them', differ, [])
}

// What used to answer fixed or missing, each now read off the rows the fake
// holds: accounts and user search, the repository qualifiers, a
// pull request's diff with its files, commits and review comments, and the
// commit list's paging and filters, plus annotated tags.
async function diffsSearchAndHistory(at: string): Promise<void> {
  const run = 'diffs-search-history'
  const base = `${at}/_run/${run}`
  await post(`${base}/reset`, { run, tenants: [TENANT], fixture: 'v1' })
  const repo = `${base}/repos/${REPO}`
  const put = (path: string, branch: string, text: string, sha?: JsonValue) =>
    send('PUT', `${repo}/contents/${path}`, {
      message: `Add ${path}`,
      content: Buffer.from(text).toString('base64'),
      branch,
      ...(sha === undefined ? {} : { sha }),
    })
  const list = (body: JsonValue, key: string): JsonValue[] =>
    ((Array.isArray(body) ? body : field(body, 'items')) as JsonValue[]).map((row) =>
      field(row, key),
    )

  // ---- accounts: the fixture's, the authenticated user, and each owner
  const users = async (q: string, extra = ''): Promise<JsonValue[]> =>
    list(
      (await send('GET', `${base}/search/users?q=${encodeURIComponent(q)}${extra}`)).body,
      'login',
    )
  eq('user search leads with the exact login', await users('integ'), ['integ', 'integ-user'])
  eq('type:user keeps users', await users('integ type:user'), ['integ-user'])
  eq('type:org keeps organizations', await users('integ type:org'), ['integ'])
  eq('fullname: reads the stated name', await users('fullname:"Integ Fixtures"'), ['integ'])
  eq('created: reads the stated date', await users('created:<2021-01-01'), ['integ'])
  eq('repos: counts what an account owns', await users('repos:>=4'), ['integ'])
  eq('sort=joined orders by creation', await users('integ', '&sort=joined&order=asc'), [
    'integ',
    'integ-user',
  ])
  const item = field((await send('GET', `${base}/search/users?q=integ-user`)).body, 'items')
  eq(
    "an item has GitHub's keys",
    Object.keys(((item as JsonValue[])[0] ?? {}) as Record<string, JsonValue>).sort(),
    [
      'avatar_url',
      'events_url',
      'followers_url',
      'following_url',
      'gists_url',
      'gravatar_id',
      'html_url',
      'id',
      'login',
      'node_id',
      'organizations_url',
      'received_events_url',
      'repos_url',
      'score',
      'site_admin',
      'starred_url',
      'subscriptions_url',
      'type',
      'url',
      'user_view_type',
    ],
  )
  eq('an empty user search is refused', (await send('GET', `${base}/search/users?q=`)).status, 422)
  const org = await send('GET', `${base}/users/INTEG`)
  eq(
    'an account reads in any case',
    [org.status, field(org.body, 'login'), field(org.body, 'name'), field(org.body, 'type')],
    [200, 'integ', 'Integ Fixtures', 'Organization'],
  )
  eq('a login nobody holds is no account', (await send('GET', `${base}/users/nobody`)).status, 404)

  // ---- repository search narrows by every qualifier it holds data for
  const repos = async (q: string): Promise<JsonValue> => {
    const body = (await send('GET', `${base}/search/repositories?q=${encodeURIComponent(q)}`)).body
    return [field(body, 'total_count'), list(body, 'full_name')]
  }
  eq('repo: narrows to the named repository', await repos(`repo:${REPO}`), [1, [REPO]])
  eq('several repo: OR together', await repos(`repo:${REPO} repo:integ/data-v1`), [
    2,
    ['integ/data-v1', REPO],
  ])
  eq('created: compares the creation date', await repos(`repo:${REPO} created:<2000-01-01`), [
    0,
    [],
  ])
  eq('an open range reads *', await repos(`repo:${REPO} created:2025-01-01..*`), [1, [REPO]])
  eq('pushed: compares the push date', await repos(`repo:${REPO} pushed:>2030-01-01`), [0, []])
  eq('stars: compares the count', await repos(`repo:${REPO} stars:>0`), [0, []])

  // ---- a pull request's files, counts, commits and diff are its range's
  const main = field(field((await send('GET', `${repo}/git/ref/heads/main`)).body, 'object'), 'sha')
  await send('POST', `${repo}/git/refs`, { ref: 'refs/heads/feature', sha: main })
  await put('hello.txt', 'feature', 'one\ntwo\nthree\n')
  await put('notes.txt', 'feature', 'four\nfive\n')
  const readmeSha = field((await send('GET', `${repo}/contents/README.md?ref=feature`)).body, 'sha')
  const readme = '# repo-v1\n\nFixture repository for the GitHub fake.\n'
  await put('README.md', 'feature', readme, readmeSha)
  const opened = await send('POST', `${repo}/pulls`, {
    title: 'Add two files',
    head: 'feature',
    base: 'main',
  })
  const number = String(field(opened.body, 'number'))
  const pull = (await send('GET', `${repo}/pulls/${number}`)).body
  eq(
    'the counts are the range',
    ['additions', 'deletions', 'changed_files', 'commits'].map((key) => field(pull, key)),
    [6, 1, 3, 3],
  )
  const files = (await send('GET', `${repo}/pulls/${number}/files`)).body as JsonValue[]
  eq(
    'the files are what the head changed',
    files.map((f) =>
      ['filename', 'status', 'additions', 'deletions', 'changes'].map((k) => field(f, k)),
    ),
    [
      ['README.md', 'modified', 1, 1, 2],
      ['hello.txt', 'added', 3, 0, 3],
      ['notes.txt', 'added', 2, 0, 2],
    ],
  )
  eq('a file carries its patch', field(files[2] ?? null, 'patch'), '@@ -0,0 +1,2 @@\n+four\n+five')
  const paged = await send('GET', `${repo}/pulls/${number}/files?per_page=2`)
  eq(
    'the files page',
    [(paged.body as JsonValue[]).length, paged.link.includes('rel="next"')],
    [2, true],
  )
  eq(
    'the commits are the head past the base, oldest first',
    ((await send('GET', `${repo}/pulls/${number}/commits`)).body as JsonValue[]).map((c) =>
      field(field(c, 'commit'), 'message'),
    ),
    ['Add hello.txt', 'Add notes.txt', 'Add README.md'],
  )
  const before = await fixtureTree('github/repo-v1')
  const after = new Map(before)
  after.set('hello.txt', Buffer.from('one\ntwo\nthree\n'))
  after.set('notes.txt', Buffer.from('four\nfive\n'))
  after.set('README.md', Buffer.from(readme))
  const diff = await send(
    'GET',
    `${repo}/pulls/${number}`,
    undefined,
    'application/vnd.github.diff',
  )
  eq(
    'the diff is the one git prints',
    diff.bytes.toString('latin1'),
    (await gitDiff(before, after)).toString('latin1'),
  )
  const patch = await send(
    'GET',
    `${repo}/pulls/${number}`,
    undefined,
    'application/vnd.github.patch',
  )
  eq(
    'a patch is refused rather than answered as JSON',
    [patch.status, field(patch.body, 'message')],
    [415, 'A patch is a mail per commit, which the integ fake does not model.'],
  )
  // A rename, a removal, a name with a space, a binary, a last line that
  // loses its newline and a text in Latin-1, compared the same way.
  const LATIN1 = Buffer.from('caf\u00e9\n', 'latin1')
  await send('POST', `${repo}/git/refs`, { ref: 'refs/heads/shuffle', sha: main })
  const shaOn = async (path: string): Promise<JsonValue> =>
    field((await send('GET', `${repo}/contents/${path}?ref=shuffle`)).body, 'sha')
  const drop = async (path: string): Promise<void> => {
    const sha = await shaOn(path)
    await send('DELETE', `${repo}/contents/${path}`, {
      message: `Drop ${path}`,
      sha,
      branch: 'shuffle',
    })
  }
  const moved = before.get('docs/contributing.md') ?? Buffer.alloc(0)
  await put('moved/contributing.md', 'shuffle', moved.toString())
  await drop('docs/contributing.md')
  await drop('docs/release.md')
  await put('notes with space.txt', 'shuffle', 'spaced\n')
  await send('PUT', `${repo}/contents/blob.bin`, {
    message: 'Add blob.bin',
    content: Buffer.from([0, 1, 2, 3]).toString('base64'),
    branch: 'shuffle',
  })
  await put('README.md', 'shuffle', '# repo-v1', await shaOn('README.md'))
  await send('PUT', `${repo}/contents/legacy.txt`, {
    message: 'Add legacy.txt',
    content: LATIN1.toString('base64'),
    branch: 'shuffle',
  })
  const shuffled = new Map(before)
  shuffled.delete('docs/contributing.md')
  shuffled.delete('docs/release.md')
  shuffled.set('moved/contributing.md', moved)
  shuffled.set('notes with space.txt', Buffer.from('spaced\n'))
  shuffled.set('blob.bin', Buffer.from([0, 1, 2, 3]))
  shuffled.set('README.md', Buffer.from('# repo-v1'))
  shuffled.set('legacy.txt', LATIN1)
  const spread = await send(
    'GET',
    `${repo}/compare/main...shuffle`,
    undefined,
    'application/vnd.github.diff',
  )
  eq(
    'every kind of change reads as git prints it',
    spread.bytes.toString('latin1'),
    (await gitDiff(before, shuffled)).toString('latin1'),
  )
  const compared = (await send('GET', `${repo}/compare/main...shuffle`)).body
  eq(
    'a comparison lists the rename once, with where it came from',
    ((field(compared, 'files') ?? []) as JsonValue[])
      .filter((f) => field(f, 'status') === 'renamed')
      .map((f) => [field(f, 'filename'), field(f, 'previous_filename'), field(f, 'patch')]),
    [['moved/contributing.md', 'docs/contributing.md', null]],
  )
  const graph = await send('POST', `${base}/graphql`, {
    query:
      `{ repository(owner: "integ", name: "repo-v1") { pullRequest(number: ${number}) { ` +
      'additions deletions changedFiles files(first: 10) { nodes { path changeType } } ' +
      'commits(last: 1) { totalCount nodes { commit { messageHeadline } } } } } }',
  })
  eq(
    'GraphQL reads the same range',
    field(field(field(graph.body, 'data'), 'repository'), 'pullRequest'),
    {
      additions: 6,
      deletions: 1,
      changedFiles: 3,
      files: {
        nodes: [
          { path: 'README.md', changeType: 'MODIFIED' },
          { path: 'hello.txt', changeType: 'ADDED' },
          { path: 'notes.txt', changeType: 'ADDED' },
        ],
      },
      commits: { totalCount: 3, nodes: [{ commit: { messageHeadline: 'Add README.md' } }] },
    },
  )
  const newest = await send('POST', `${base}/graphql`, {
    query:
      `{ repository(owner: "integ", name: "repo-v1") { pullRequest(number: ${number}) { ` +
      'commits(last: 2) { totalCount pageInfo { hasNextPage endCursor } ' +
      'nodes { commit { messageHeadline } } } } } }',
  })
  eq(
    'the newest commits page from where they start in the whole history',
    field(field(field(field(newest.body, 'data'), 'repository'), 'pullRequest'), 'commits'),
    {
      totalCount: 3,
      pageInfo: { hasNextPage: false, endCursor: Buffer.from('3').toString('base64') },
      nodes: [
        { commit: { messageHeadline: 'Add notes.txt' } },
        { commit: { messageHeadline: 'Add README.md' } },
      ],
    },
  )
  const orphanTree = field(
    (await send('POST', `${repo}/git/trees`, { tree: [{ path: 'only.txt', content: 'x\n' }] }))
      .body,
    'sha',
  )
  const orphan = await send('POST', `${repo}/git/commits`, {
    message: 'Start over',
    tree: orphanTree,
    parents: [],
  })
  await send('POST', `${repo}/git/refs`, {
    ref: 'refs/heads/orphan',
    sha: field(orphan.body, 'sha'),
  })
  eq(
    'a head with no history in common with its base opens nothing',
    field(
      (await send('POST', `${repo}/pulls`, { title: 'x', head: 'orphan', base: 'main' })).body,
      'errors',
    ),
    [
      {
        resource: 'PullRequest',
        code: 'custom',
        message: 'The orphan branch has no history in common with main',
      },
    ],
  )

  // ---- review comments land on lines the diff shows
  const comments = `${repo}/pulls/${number}/comments`
  const made = await send('POST', comments, { body: 'nice', path: 'hello.txt', line: 2 })
  eq(
    'a comment lands on a line the diff shows',
    [
      made.status,
      field(made.body, 'line'),
      field(made.body, 'side'),
      field(made.body, 'diff_hunk'),
    ],
    [201, 2, 'RIGHT', '@@ -0,0 +1,3 @@\n+one\n+two'],
  )
  const prCommits = list((await send('GET', `${repo}/pulls/${number}/commits`)).body, 'sha')
  eq(
    'a comment names a commit of the pull request or none',
    [
      (
        await send('POST', comments, {
          body: 'x',
          path: 'hello.txt',
          line: 1,
          commit_id: '0'.repeat(40),
        })
      ).status,
      field(
        (
          await send('POST', comments, {
            body: 'older',
            path: 'hello.txt',
            line: 1,
            commit_id: prCommits[0] ?? null,
          })
        ).body,
        'commit_id',
      ),
    ],
    [422, prCommits[0] ?? null],
  )
  eq(
    'a review names one of its head too, never an unrelated commit',
    (
      await send('POST', `${repo}/pulls/${number}/reviews`, {
        event: 'COMMENT',
        body: 'x',
        commit_id: field(orphan.body, 'sha'),
      })
    ).status,
    422,
  )
  eq(
    'a comment off the diff is refused',
    (await send('POST', comments, { body: 'x', path: 'hello.txt', line: 9 })).status,
    422,
  )
  eq(
    'a file the pull request leaves alone takes no comment',
    (await send('POST', comments, { body: 'x', path: 'docs/release.md', line: 1 })).status,
    422,
  )
  const reply = await send('POST', `${comments}/${String(field(made.body, 'id'))}/replies`, {
    body: 'thanks',
  })
  eq(
    'a reply takes the place of what it answers',
    [field(reply.body, 'in_reply_to_id'), field(reply.body, 'path'), field(reply.body, 'line')],
    [field(made.body, 'id'), 'hello.txt', 2],
  )
  const reviewed = await send('POST', `${repo}/pulls/${number}/reviews`, {
    event: 'COMMENT',
    body: 'see',
    comments: [{ path: 'README.md', line: 3, side: 'LEFT', body: 'old' }],
  })
  eq('a review carries its comments', reviewed.status, 200)
  eq('every comment is listed', list((await send('GET', comments)).body, 'body'), [
    'nice',
    'older',
    'thanks',
    'old',
  ])
  eq(
    'each comment outside a review is a review of its own',
    ((await send('GET', `${repo}/pulls/${number}/reviews`)).body as JsonValue[]).length,
    4,
  )

  // ---- the commit list pages and filters
  await put('second.txt', 'main', 'second\n')
  const shas = async (query: string): Promise<JsonValue> =>
    list((await send('GET', `${repo}/commits${query}`)).body, 'sha')
  const history = (await shas('')) as JsonValue[]
  eq('main holds the write and its root', history.length, 2)
  const first = await send('GET', `${repo}/commits?per_page=1`)
  eq(
    'per_page cuts a page',
    [list(first.body, 'sha'), first.link.includes('rel="next"')],
    [[history[0] ?? null], true],
  )
  eq('page=2 is the next page', await shas('?per_page=1&page=2'), [history[1] ?? null])
  eq('until bounds the commit date', await shas('?until=2000-01-01T00:00:00Z'), [
    history[1] ?? null,
  ])
  eq('since bounds it too', await shas('?since=2100-01-01T00:00:00Z'), [])
  eq('a since that is no date bounds everything out', await shas('?since=abc'), [])
  eq('author reads the login', await shas('?author=integ-user'), [history[0] ?? null])
  eq('an author nobody is matches nothing', await shas('?author=nobody'), [])
  eq('path keeps the commits that touched it', await shas('?path=second.txt'), [history[0] ?? null])
  eq('a directory path reads beneath it', await shas('?path=docs'), [history[1] ?? null])
  eq('a path nothing touched matches nothing', await shas('?path=missing.txt'), [])
  const one = (await send('GET', `${repo}/commits/${String(history[0])}`)).body
  eq(
    "a commit's files are its tree against its parent's",
    [
      field(one, 'stats'),
      ((field(one, 'files') ?? []) as JsonValue[]).map((f) => [
        field(f, 'filename'),
        field(f, 'status'),
      ]),
    ],
    [{ total: 1, additions: 1, deletions: 0 }, [['second.txt', 'added']]],
  )

  // ---- annotated tags are objects a ref can name
  const head = history[0] ?? null
  const tag = await send('POST', `${repo}/git/tags`, {
    tag: 'v1',
    message: 'first',
    object: head,
    type: 'commit',
  })
  eq('an annotated tag is created', tag.status, 201)
  const read = await send('GET', `${repo}/git/tags/${String(field(tag.body, 'sha'))}`)
  eq(
    'and reads back by its sha',
    [read.status, field(read.body, 'tag'), field(field(read.body, 'object'), 'sha')],
    [200, 'v1', head],
  )
  eq(
    'a sha no tag has is 404',
    (await send('GET', `${repo}/git/tags/${'0'.repeat(40)}`)).status,
    404,
  )
  eq(
    'a tag of nothing is refused',
    field(
      (
        await send('POST', `${repo}/git/tags`, {
          tag: 'x',
          message: 'x',
          object: 'nope',
          type: 'commit',
        })
      ).body,
      'message',
    ),
    'Object does not exist',
  )
  eq(
    'a tag needs its fields',
    field((await send('POST', `${repo}/git/tags`, {})).body, 'message'),
    'Invalid request.\n\n"tag", "message", "object", "type" weren\'t supplied.',
  )
  const annotated = await send('POST', `${repo}/git/refs`, {
    ref: 'refs/tags/v1',
    sha: field(tag.body, 'sha'),
  })
  const light = await send('POST', `${repo}/git/refs`, { ref: 'refs/tags/light', sha: head })
  eq(
    'a tag ref names a tag object or a commit',
    [field(field(annotated.body, 'object'), 'type'), field(field(light.body, 'object'), 'type')],
    ['tag', 'commit'],
  )
  eq(
    'a tag ref reads back',
    field(field((await send('GET', `${repo}/git/ref/tags/v1`)).body, 'object'), 'type'),
    'tag',
  )
  eq(
    'a tag names content and history as a branch does',
    [
      (await send('GET', `${repo}/contents/second.txt?ref=v1`)).status,
      (await send('GET', `${repo}/contents/second.txt?ref=refs/tags/light`)).status,
      list((await send('GET', `${repo}/commits?sha=v1`)).body, 'sha')[0] ?? null,
    ],
    [200, 200, head],
  )
  eq(
    'the tags list newest name first, each at its commit',
    ((await send('GET', `${repo}/tags`)).body as JsonValue[]).map((t) => [
      field(t, 'name'),
      field(field(t, 'commit'), 'sha'),
    ]),
    [
      ['v1', head],
      ['light', head],
    ],
  )
}

async function reviewAncestry(at: string): Promise<void> {
  const run = 'review-ancestry'
  const base = `${at}/_run/${run}`
  await post(`${base}/reset`, { run, tenants: [TENANT], fixture: 'v1' })
  const repo = `${base}/repos/${REPO}`
  const root = field(field(await get(`${repo}/git/ref/heads/main`), 'object'), 'sha')
  await post(`${repo}/git/refs`, { ref: 'refs/heads/review', sha: root })
  const first = await send('PUT', `${repo}/contents/review.txt`, {
    message: 'First revision',
    content: Buffer.from('first\n').toString('base64'),
    branch: 'review',
  })
  const firstSha = field(field(first.body, 'commit'), 'sha')
  const second = await send('PUT', `${repo}/contents/review.txt`, {
    message: 'Second revision',
    content: Buffer.from('second\n').toString('base64'),
    sha: field(field(first.body, 'content'), 'sha'),
    branch: 'review',
  })
  const head = field(field(second.body, 'commit'), 'sha')
  const opened = await post(`${repo}/pulls`, {
    title: 'Review ancestry',
    head: 'review',
    base: 'main',
  })
  eq('review ancestry pull opens', opened.status, 201)
  const pull = `${repo}/pulls/${String(field(opened.body, 'number'))}`
  const advanced = await send('PATCH', `${repo}/git/refs/heads/main`, { sha: firstSha })
  eq('base advances through the first review commit', advanced.status, 200)
  eq(
    'the current pull range now holds only the second commit',
    ((await get(`${pull}/commits`)) as JsonValue[]).map((row) => field(row, 'sha')),
    [head],
  )
  for (const commit of [firstSha, head]) {
    const comment = { body: 'Still reviewable', path: 'review.txt', line: 1 }
    const made = await post(`${pull}/comments`, { ...comment, commit_id: commit })
    eq(
      'an ancestor remains reviewable after the base advances',
      [made.status, field(made.body, 'commit_id')],
      [201, commit],
    )
    const reviewed = await post(`${pull}/reviews`, {
      event: 'COMMENT',
      body: 'Review with a comment',
      commit_id: commit,
      comments: [comment],
    })
    eq(
      'a batch review uses the same ancestry validation',
      [reviewed.status, field(reviewed.body, 'commit_id')],
      [200, commit],
    )
    const saved = await get(`${pull}/comments`)
    eq(
      'the batched comment keeps its reviewed commit',
      (saved as JsonValue[])
        .filter((row) => field(row, 'pull_request_review_id') === field(reviewed.body, 'id'))
        .map((row) => field(row, 'commit_id')),
      [commit],
    )
  }
  await send('PATCH', `${repo}/git/refs/heads/main`, { sha: head })
  eq('base can catch up to every pull commit', await get(`${pull}/commits`), [])
  for (const commit of [null, head, firstSha]) {
    const reviewed = await post(`${pull}/reviews`, {
      event: 'COMMENT',
      body: 'Review after base catches up',
      ...(commit === null ? {} : { commit_id: commit }),
    })
    eq(
      'explicit and default review commits survive an empty diff range',
      [reviewed.status, field(reviewed.body, 'commit_id')],
      [200, commit ?? head],
    )
  }
  const outside = await send('PUT', `${repo}/contents/base-only.txt`, {
    message: 'Only on base',
    content: Buffer.from('base\n').toString('base64'),
    branch: 'main',
  })
  const outsideSha = field(field(outside.body, 'commit'), 'sha')
  for (const commit of [outsideSha, '0'.repeat(40)]) {
    const refused = await post(`${pull}/reviews`, {
      event: 'COMMENT',
      body: 'Not in head ancestry',
      commit_id: commit,
    })
    eq(
      'a base-only or nonexistent commit is still refused',
      [refused.status, field(refused.body, 'errors')],
      [422, [{ resource: 'PullRequestReview', code: 'invalid', field: 'commit_id' }]],
    )
  }
  const rewound = await send('PATCH', `${repo}/git/refs/heads/main`, { sha: firstSha, force: true })
  eq('base rewinds to restore a commentable diff', rewound.status, 200)
  const refused = await post(`${pull}/comments`, {
    body: 'Not in head ancestry',
    path: 'review.txt',
    line: 1,
    commit_id: outsideSha,
  })
  eq(
    'standalone comments also refuse an existing commit outside head ancestry',
    [refused.status, field(refused.body, 'errors')],
    [422, [{ resource: 'PullRequestReviewComment', code: 'invalid', field: 'commit_id' }]],
  )
}

// A merge names every parent, and every walk follows each of them: the
// listing reaches what only the second parent reaches, a branch merged into
// another reads as behind it, `^2` names the second parent, and a ref moves
// onto the merge as a fast forward. GraphQL's `history` lists what the REST
// listing lists, and a path's history drops a merge that took one side's
// version, with the side it did not take. The fixture states the octocat
// history GitHub answers for `octocat/Hello-World` (2026-09-30, its GraphQL
// answers 2026-10-03); the rest is built through the git data API.
async function mergeHistory(at: string): Promise<void> {
  const shas = (body: JsonValue): JsonValue[] =>
    (body as JsonValue[]).map((row) => field(row, 'sha'))
  const run = 'merge-history'
  const base = `${at}/_run/${run}`
  await post(`${base}/reset`, { run, tenants: [TENANT], fixture: 'merges' })
  const hello = `${base}/repos/octocat/Hello-World`
  const merge = '7fd1a60b01f91b314f59955a4e4d4e80d8edf11d'
  const side = '762941318ee16e59dabbacb1b4049eec22f0d303'
  const first = '553c2077f0edc3d5dc5d17262f6aa498e69d6f8e'
  eq(
    'a fixture merge lists the commit only its second parent reaches',
    shas(await get(`${hello}/commits?sha=master`)),
    [merge, side, first],
  )
  eq(
    'a fixture merge names both parents in order',
    shas(field(await get(`${hello}/commits/${merge}`), 'parents')),
    [first, side],
  )
  const merged = await get(`${hello}/compare/${side}...master`)
  eq(
    'a branch merged into the base is behind it, not diverged',
    [field(merged, 'status'), field(merged, 'ahead_by'), field(merged, 'behind_by')],
    ['ahead', 1, 0],
  )
  eq('^2 names the second parent', field(await get(`${hello}/commits/master^2`), 'sha'), side)
  eq('~1 follows the first parent', field(await get(`${hello}/commits/master~1`), 'sha'), first)
  eq('^3 names nothing', (await send('GET', `${hello}/commits/master^3`)).status, 422)
  const graph = async (query: string): Promise<JsonValue> =>
    field(field((await send('POST', `${base}/graphql`, { query })).body, 'data'), 'repository')
  const history = (args: string): string =>
    `defaultBranchRef { name prefix target { __typename oid ... on Commit { ` +
    `history(${args}) { totalCount pageInfo { hasNextPage endCursor } nodes { oid } } } } }`
  const listed = (repository: JsonValue): JsonValue =>
    field(field(field(repository, 'defaultBranchRef'), 'target'), 'history')
  const read = await graph(
    `{ repository(owner: "octocat", name: "Hello-World") { ${history('first: 2')} } }`,
  )
  const oids = (connection: JsonValue): JsonValue[] =>
    (field(connection, 'nodes') as JsonValue[]).map((node) => field(node, 'oid'))
  eq(
    'GraphQL history reaches what only the second parent reaches',
    [field(listed(read), 'totalCount'), oids(listed(read))],
    [3, [merge, side]],
  )
  eq(
    'defaultBranchRef names its namespace and its head',
    [
      field(field(read, 'defaultBranchRef'), 'prefix'),
      field(field(field(read, 'defaultBranchRef'), 'target'), '__typename'),
    ],
    ['refs/heads/', 'Commit'],
  )
  const cursor = field(field(listed(read), 'pageInfo'), 'endCursor')
  const rest = await graph(
    `{ repository(owner: "octocat", name: "Hello-World") { ` +
      `${history(`first: 2, after: ${JSON.stringify(cursor)}`)} } }`,
  )
  eq('GraphQL history pages on', oids(listed(rest)), [first])
  const bounded = await graph(
    `{ repository(owner: "octocat", name: "Hello-World") { defaultBranchRef { target { ` +
      `... on Commit { since: history(since: "2012-01-01T00:00:00Z") { nodes { oid } } ` +
      `until: history(until: "2011-01-27T00:00:00Z") { nodes { oid } } } } } } }`,
  )
  const target = field(field(bounded, 'defaultBranchRef'), 'target')
  eq(
    'GraphQL history is bounded by commit date',
    [field(target, 'since'), field(target, 'until')],
    [{ nodes: [{ oid: merge }] }, { nodes: [{ oid: first }] }],
  )
  const refs = await graph(
    `{ repository(owner: "octocat", name: "Hello-World") { ` +
      `short: ref(qualifiedName: "master") { name prefix } ` +
      `full: ref(qualifiedName: "refs/heads/master") { name prefix } ` +
      `partial: ref(qualifiedName: "heads/master") { name } ` +
      `missing: ref(qualifiedName: "nosuch") { name } } }`,
  )
  eq('ref() reads a short name, a full one, and nothing else', refs, {
    short: { name: 'master', prefix: 'refs/heads/' },
    full: { name: 'master', prefix: 'refs/heads/' },
    partial: null,
    missing: null,
  })

  const built = `${at}/_run/merge-built`
  await post(`${built}/reset`, { run: 'merge-built', tenants: [TENANT], fixture: 'v1' })
  const repo = `${built}/repos/${REPO}`
  const root = field(field(await get(`${repo}/git/ref/heads/main`), 'object'), 'sha')
  await post(`${repo}/git/refs`, { ref: 'refs/heads/topic', sha: root })
  const onTopic = await send('PUT', `${repo}/contents/topic.txt`, {
    message: 'On topic',
    content: Buffer.from('topic\n').toString('base64'),
    branch: 'topic',
  })
  const topic = field(field(onTopic.body, 'commit'), 'sha')
  const onMain = await send('PUT', `${repo}/contents/main.txt`, {
    message: 'On main',
    content: Buffer.from('main\n').toString('base64'),
    branch: 'main',
  })
  const tip = field(field(onMain.body, 'commit'), 'sha')
  const tree = field(field(await get(`${repo}/git/commits/${String(tip)}`), 'tree'), 'sha')
  const made = await post(`${repo}/git/commits`, {
    message: 'Merge topic',
    tree,
    parents: [tip, topic],
  })
  const sha = field(made.body, 'sha')
  eq('POST git/commits keeps every parent it is given', shas(field(made.body, 'parents')), [
    tip,
    topic,
  ])
  eq(
    'GET git/commits reads every parent back',
    shas(field(await get(`${repo}/git/commits/${String(sha)}`), 'parents')),
    [tip, topic],
  )
  eq(
    'a ref moves onto a merge of itself as a fast forward',
    (await send('PATCH', `${repo}/git/refs/heads/main`, { sha })).status,
    200,
  )
  eq(
    'the branch lists both sides of its merge',
    shas(await get(`${repo}/commits?sha=main`)).slice(0, 3),
    [sha, tip, topic],
  )
  const behind = await get(`${repo}/compare/main...topic`)
  eq(
    'the merged branch is behind the branch it was merged into',
    [field(behind, 'status'), field(behind, 'ahead_by'), field(behind, 'behind_by')],
    ['behind', 0, 2],
  )
  const sameSecond = { name: 'Tie', email: 'tie@example.com', date: '2026-01-01T00:00:00Z' }
  const treeWith = async (base: JsonValue, names: string[]): Promise<JsonValue> =>
    field(
      (
        await post(`${repo}/git/trees`, {
          base_tree: base,
          tree: names.map((path) => ({ path, mode: '100644', type: 'blob', content: `${path}\n` })),
        })
      ).body,
      'sha',
    )
  const commitOf = async (
    message: string,
    tree: JsonValue,
    parents: JsonValue[],
  ): Promise<JsonValue> =>
    field(
      (
        await post(`${repo}/git/commits`, {
          message,
          tree,
          parents,
          author: sameSecond,
          committer: sameSecond,
        })
      ).body,
      'sha',
    )
  const rootTree = field(field(await get(`${repo}/git/commits/${String(root)}`), 'tree'), 'sha')
  const shared = await commitOf('shared', rootTree, [root])
  const onBase = await commitOf('on base', await treeWith(rootTree, ['y.txt']), [shared])
  const left = await commitOf('left', await treeWith(rootTree, ['x.txt']), [shared])
  const right = await commitOf('right', await treeWith(rootTree, ['y.txt', 'z.txt']), [onBase])
  const tied = await commitOf('merge', await treeWith(rootTree, ['x.txt', 'y.txt', 'z.txt']), [
    left,
    right,
  ])
  await post(`${repo}/git/refs`, { ref: 'refs/heads/tie-base', sha: onBase })
  await post(`${repo}/git/refs`, { ref: 'refs/heads/tie-head', sha: tied })
  const tie = await get(`${repo}/compare/tie-base...tie-head`)
  eq(
    'the merge base is the shared commit no other shared commit reaches, dates tied',
    [
      field(tie, 'ahead_by'),
      field(tie, 'behind_by'),
      ((field(tie, 'files') ?? []) as JsonValue[]).map((f) => field(f, 'filename')),
    ],
    [3, 0, ['x.txt', 'z.txt']],
  )
  eq(
    "a path's history follows the side a merge took it from",
    shas(await get(`${repo}/commits?sha=main&path=main.txt`)),
    [tip],
  )
  eq(
    "a path's history drops the side a merge did not take",
    shas(await get(`${repo}/commits?sha=main&path=topic.txt`)),
    [],
  )
  const [owner, name] = REPO.split('/')
  const pathed = await send('POST', `${built}/graphql`, {
    query:
      `{ repository(owner: "${String(owner)}", name: "${String(name)}") { ` +
      `ref(qualifiedName: "main") { target { ... on Commit { ` +
      `kept: history(path: "main.txt") { nodes { oid } } ` +
      `dropped: history(path: "topic.txt") { totalCount } } } } } }`,
  })
  eq(
    "GraphQL history reads a path's history the same way",
    field(field(field(field(pathed.body, 'data'), 'repository'), 'ref'), 'target'),
    { kept: { nodes: [{ oid: tip }] }, dropped: { totalCount: 0 } },
  )
}

async function refIdentity(at: string): Promise<void> {
  const run = 'ref-identity'
  const base = `${at}/_run/${run}`
  await post(`${base}/reset`, { run, tenants: [TENANT], fixture: 'v1' })
  const repo = `${base}/repos/${REPO}`
  const root = String(field(field(await get(`${repo}/git/ref/heads/main`), 'object'), 'sha'))
  const written = await send('PUT', `${repo}/contents/identity.txt`, {
    message: 'Identity',
    content: Buffer.from('identity\n').toString('base64'),
    branch: 'main',
  })
  const head = String(field(field(written.body, 'commit'), 'sha'))
  const annotated = await post(`${repo}/git/tags`, {
    tag: 'old',
    message: 'Old revision',
    type: 'commit',
    object: root,
  })
  const tagSha = field(annotated.body, 'sha')
  // A branch spelled under `tags/` is still found by that name, and a tag of
  // the name that follows wins over it, in git's order.
  const slashed = await post(`${repo}/git/refs`, { ref: 'refs/heads/tags/release', sha: head })
  eq('a branch may be named under tags/', slashed.status, 201)
  const byName = async (): Promise<JsonValue> =>
    field(await get(`${repo}/commits/tags/release`), 'sha')
  eq('and reads by that name while no tag is called release', await byName(), head)
  await post(`${repo}/git/refs`, { ref: 'refs/tags/release', sha: root })
  eq('a tag called release is read first once it exists', await byName(), root)
  for (const [name, target] of [
    [root, head],
    [head, tagSha],
  ] as const) {
    const made = await post(`${repo}/git/refs`, { ref: `refs/tags/${String(name)}`, sha: target })
    eq('a tag may have a full commit sha as its name', made.status, 201)
  }
  for (const prefix of ['', '/api/v3']) {
    const api = `${base}${prefix}/repos/${REPO}`
    for (const [sha, contentStatus] of [
      [root, 404],
      [head, 200],
    ] as const) {
      for (const spelling of [sha, sha.toUpperCase(), sha.slice(0, 7)]) {
        eq(
          'commit identity wins over a sha-named tag',
          field(await get(`${api}/commits/${spelling}`), 'sha'),
          sha,
        )
        eq(
          'history starts at the named commit rather than the tag target',
          field(((await get(`${api}/commits?sha=${spelling}`)) as JsonValue[])[0] ?? null, 'sha'),
          sha,
        )
        eq(
          'content comes from the named commit',
          (await send('GET', `${api}/contents/identity.txt?ref=${spelling}`)).status,
          contentStatus,
        )
      }
    }
    const compared = await get(`${api}/compare/${root}...${head}`)
    eq(
      'comparison preserves commit identity on both sides',
      [field(compared, 'status'), field(compared, 'ahead_by'), field(compared, 'behind_by')],
      ['ahead', 1, 0],
    )
    for (const qualifier of ['tags/', 'refs/tags/']) {
      eq(
        'a qualified sha-named tag still names its own target',
        [
          (await send('GET', `${api}/contents/identity.txt?ref=${qualifier}${root}`)).status,
          (await send('GET', `${api}/contents/identity.txt?ref=${qualifier}${head}`)).status,
        ],
        [200, 404],
      )
    }
  }
  const copied = await post(`${repo}/git/tags`, {
    tag: 'new',
    message: 'New revision',
    type: 'commit',
    object: head,
  })
  eq(
    'a sha-named tag cannot prevent another tag from naming the commit',
    [copied.status, field(field(copied.body, 'object'), 'sha')],
    [201, head],
  )
  const branch = await post(`${repo}/git/refs`, { ref: 'refs/heads/copy', sha: head })
  eq(
    'a branch created by sha uses the commit rather than the tag target',
    [branch.status, (await send('GET', `${repo}/contents/identity.txt?ref=copy`)).status],
    [201, 200],
  )
  for (const [name, target] of [
    [head, root],
    [`tags/${head}`, head],
  ] as const) {
    const made = await post(`${repo}/git/refs`, { ref: `refs/heads/${name}`, sha: target })
    eq('a branch may overlap an object or tag spelling', made.status, 201)
  }
  for (const [ref, expected] of [
    [head, head],
    [`heads/${head}`, root],
    [`refs/heads/${head}`, root],
    [`tags/${head}`, root],
    [`refs/tags/${head}`, root],
    [`refs/heads/tags/${head}`, head],
  ] as const) {
    eq(
      'qualified names resolve only within their namespace',
      field(await get(`${repo}/commits/${encodeURIComponent(ref)}`), 'sha'),
      expected,
    )
  }
  const opened = await post(`${repo}/pulls`, {
    title: 'Branches with ambiguous names',
    head: `tags/${head}`,
    base: head,
  })
  eq(
    'pull creation resolves head and base as branch names',
    [
      opened.status,
      field(field(opened.body, 'head'), 'sha'),
      field(field(opened.body, 'base'), 'sha'),
    ],
    [201, head, root],
  )
  const pull = await get(`${repo}/pulls/${String(field(opened.body, 'number'))}`)
  eq(
    'pull reads preserve the same branch identity',
    [field(field(pull, 'head'), 'sha'), field(field(pull, 'base'), 'sha'), field(pull, 'commits')],
    [head, root, 1],
  )
  const short = await post(`${repo}/git/refs`, { ref: `refs/tags/${head.slice(0, 7)}`, sha: root })
  eq('an abbreviated sha can also name a tag', short.status, 201)
  eq(
    'bare tag names still take precedence over abbreviated commits',
    field(await get(`${repo}/commits/${head.slice(0, 7)}`), 'sha'),
    root,
  )
}

// Owner scope, issue search's `is:` and `sort:`, the order lists are sorted
// and paged in, pull requests in the issue list, profiles, a repository's
// languages, people and events, the rate limit, and pull requests from forks.
async function listsProfilesAndForks(at: string): Promise<void> {
  const run = 'lists-profiles-forks'
  const base = `${at}/_run/${run}`
  await post(`${base}/reset`, { run, tenants: [TENANT], fixture: 'v1' })
  const repo = `${base}/repos/${REPO}`
  const send = async (
    method: string,
    url: string,
    body?: JsonValue,
    headers: Record<string, string> = HEADERS,
  ): Promise<{ status: number; body: JsonValue }> => {
    const r = await fetch(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await r.text()
    return { status: r.status, body: text === '' ? null : (JSON.parse(text) as JsonValue) }
  }
  const items = (body: JsonValue): JsonValue[] =>
    (Array.isArray(body) ? body : ((field(body, 'items') ?? []) as JsonValue[])) as JsonValue[]
  const branchOff = async (at: string, name: string, path: string): Promise<void> => {
    const head = field(field((await send('GET', `${at}/git/ref/heads/main`)).body, 'object'), 'sha')
    await send('POST', `${at}/git/refs`, { ref: `refs/heads/${name}`, sha: head })
    await send('PUT', `${at}/contents/${path}`, {
      message: `Add ${path}`,
      content: Buffer.from(`${path}\n`).toString('base64'),
      branch: name,
    })
  }

  // ---- `owner:` scopes repository search as `user:` and `org:` do
  await send('POST', `${base}/user/repos`, { name: 'own-repo' })
  eq(
    '`owner:` narrows repositories to that account',
    items((await send('GET', `${base}/search/repositories?q=owner:integ`)).body).map((r) =>
      field(r, 'full_name'),
    ),
    ['integ/data-v1', 'integ/repo-cli', 'integ/repo-trunc', 'integ/repo-v1'],
  )

  // ---- two issues and a pull request between them
  await send('POST', `${repo}/issues`, { title: 'First issue' })
  await branchOff(repo, 'one', 'one.txt')
  await send('POST', `${repo}/pulls`, { title: 'Pull from one', head: 'one', base: 'main' })
  await send('POST', `${repo}/issues`, { title: 'Second issue' })
  const found = async (q: string): Promise<JsonValue> =>
    items((await send('GET', `${base}/search/issues?q=${encodeURIComponent(q)}`)).body).map((i) =>
      field(i, 'number'),
    )
  eq('`is:issue` keeps issues', await found(`repo:${REPO} is:issue`), [3, 1])
  eq('`is:pr` keeps pull requests', await found(`repo:${REPO} is:pr`), [2])
  eq('`is:open` keeps open ones', await found(`repo:${REPO} is:open`), [3, 1, 2])
  eq(
    '`sort:created-asc` orders oldest first',
    await found(`repo:${REPO} is:issue sort:created-asc`),
    [1, 3],
  )
  eq('`org:` scopes issue search', await found(`org:integ is:issue`), [3, 1])
  eq(
    'an account nobody holds is refused as a missing repository is',
    (await send('GET', `${base}/search/issues?q=${encodeURIComponent('org:no-such-org-zz9')}`))
      .status,
    422,
  )
  eq('`user:` compares the login in any case', await found(`user:INTEG is:pr`), [2])

  // ---- lists sort and page in the order asked; the issue list holds pull requests
  await branchOff(repo, 'two', 'two.txt')
  await send('POST', `${repo}/pulls`, { title: 'Pull from two', head: 'two', base: 'main' })
  const numbers = async (path: string): Promise<JsonValue> =>
    ((await send('GET', `${repo}/${path}`)).body as JsonValue[]).map((i) => [
      field(i, 'number'),
      field(i, 'pull_request') !== null,
    ])
  eq('pulls are newest first by default', await numbers('pulls?state=all'), [
    [4, false],
    [2, false],
  ])
  eq(
    'and oldest first when asked',
    await numbers('pulls?state=all&sort=created&direction=asc&per_page=1'),
    [[2, false]],
  )
  eq('the issue list holds the pull requests too', await numbers('issues?state=all'), [
    [4, true],
    [3, false],
    [2, true],
    [1, false],
  ])
  eq(
    'in the order asked',
    await numbers('issues?state=all&sort=created&direction=asc&per_page=2'),
    [
      [1, false],
      [2, true],
    ],
  )
  eq(
    '`since` keeps what was updated after it',
    await numbers('issues?state=all&since=2100-01-01T00:00:00Z'),
    [],
  )

  // ---- a profile answers every field the fixture states
  const profile = (await send('GET', `${base}/users/integ`)).body
  eq(
    'a profile holds what the fixture states',
    [
      'name',
      'type',
      'bio',
      'company',
      'blog',
      'location',
      'followers',
      'following',
      'public_gists',
      'public_repos',
      'created_at',
      'updated_at',
    ].map((k) => field(profile, k)),
    [
      'Integ Fixtures',
      'Organization',
      'Fixtures for the integ batteries',
      '@integ',
      'https://example.test',
      'Test Lab',
      12,
      3,
      1,
      4,
      '2020-05-01T00:00:00Z',
      '2026-01-02T00:00:00Z',
    ],
  )
  const users = async (q: string): Promise<JsonValue> =>
    items((await send('GET', `${base}/search/users?q=${encodeURIComponent(q)}`)).body).map((u) =>
      field(u, 'login'),
    )
  eq('`location:` reads the profile', await users('location:"test lab"'), ['integ'])
  eq('`followers:` compares the count', await users('followers:>10'), ['integ'])
  eq('`language:` reads the repositories owned', await users('language:python'), ['integ'])

  // ---- a repository's languages, people, events and tags
  eq('languages are what Linguist counts', (await send('GET', `${repo}/languages`)).body, {
    Python: 15014,
  })
  eq(
    'a repository of data has none',
    (await send('GET', `${base}/repos/integ/data-v1/languages`)).body,
    {},
  )
  const graphLanguages = await send('POST', `${base}/graphql`, {
    query:
      '{ repository(owner: "integ", name: "repo-v1") { primaryLanguage { name } ' +
      'languages(first: 5) { edges { size node { name } } } } }',
  })
  eq('GraphQL reads the same languages', field(field(graphLanguages.body, 'data'), 'repository'), {
    primaryLanguage: { name: 'Python' },
    languages: { edges: [{ size: 15014, node: { name: 'Python' } }] },
  })
  eq(
    'a repository reports its primary language',
    field((await send('GET', repo)).body, 'language'),
    'Python',
  )
  const data = `${base}/repos/integ/data-v1`
  eq(
    'stargazers and subscribers are the ones the fixture lists',
    [
      items((await send('GET', `${data}/stargazers`)).body).map((u) => [
        field(u, 'login'),
        field(u, 'type'),
      ]),
      items((await send('GET', `${data}/subscribers`)).body).map((u) => field(u, 'login')),
      field((await send('GET', data)).body, 'stargazers_count'),
    ],
    [
      [
        ['integ-user', 'User'],
        ['integ', 'Organization'],
      ],
      ['integ-user'],
      2,
    ],
  )
  eq(
    'a tag the fixture states is listed',
    items((await send('GET', `${data}/tags`)).body).map((t) => [
      field(t, 'name'),
      field(field(t, 'commit'), 'sha'),
    ]),
    [['v0.1.0', '24f636d593911ace37ffae622f03331804f24386']],
  )
  eq(
    'contributors are the accounts that wrote the default branch',
    items((await send('GET', `${repo}/contributors?anon=1`)).body).map((c) => [
      field(c, 'login') ?? field(c, 'email'),
      field(c, 'type'),
      field(c, 'contributions'),
    ]),
    [['mirage@users.noreply.github.com', 'Anonymous', 1]],
  )
  const kinds = items((await send('GET', `${repo}/events`)).body).map((e) => field(e, 'type'))
  eq('events are the activity the fake holds, newest first', [...new Set(kinds)].sort(), [
    'CreateEvent',
    'IssuesEvent',
    'PullRequestEvent',
    'PushEvent',
  ])
  const limits = async (headers: Record<string, string>): Promise<JsonValue> => {
    const body = (await send('GET', `${base}/rate_limit`, undefined, headers)).body
    return [
      field(field(field(body, 'resources'), 'core'), 'limit'),
      field(field(field(body, 'resources'), 'search'), 'limit'),
    ]
  }
  eq('the rate limit answers a signed-in caller', await limits(HEADERS), [5000, 30])
  eq('and an anonymous one', await limits({ 'x-mirage-tenant': TENANT }), [60, 10])

  // ---- a pull request from a fork
  const tip = field(field((await send('GET', `${repo}/git/ref/heads/main`)).body, 'object'), 'sha')
  const annotated = await send('POST', `${repo}/git/tags`, {
    tag: 'v2',
    message: 'Second',
    object: tip,
    type: 'commit',
  })
  await send('POST', `${repo}/git/refs`, { ref: 'refs/tags/v2', sha: field(annotated.body, 'sha') })
  const forked = await send('POST', `${repo}/forks`, {})
  eq(
    'a fork is made',
    [forked.status, field(forked.body, 'full_name')],
    [202, 'integ-user/repo-v1'],
  )
  const fork = `${base}/repos/integ-user/repo-v1`
  await branchOff(fork, 'side', 'side.txt')
  const narrow = await send('POST', `${fork}/forks`, {
    name: 'narrow',
    organization: 'acme',
    default_branch_only: true,
  })
  eq(
    'organization names the account the fork lands in',
    field(narrow.body, 'full_name'),
    'acme/narrow',
  )
  eq(
    'default_branch_only copies the default branch alone',
    items((await send('GET', `${base}/repos/acme/narrow/branches`)).body).map((b) =>
      field(b, 'name'),
    ),
    ['main'],
  )
  eq(
    'it shares its source history',
    field(field((await send('GET', `${fork}/git/ref/heads/main`)).body, 'object'), 'sha'),
    field(field((await send('GET', `${repo}/git/ref/heads/main`)).body, 'object'), 'sha'),
  )
  await branchOff(fork, 'feature', 'forked.txt')
  const opened = await send('POST', `${repo}/pulls`, {
    title: 'From a fork',
    head: 'integ-user:feature',
    base: 'main',
  })
  const number = String(field(opened.body, 'number'))
  const pull = (await send('GET', `${repo}/pulls/${number}`)).body
  eq(
    "its head is the fork's branch",
    [
      field(field(pull, 'head'), 'label'),
      field(field(pull, 'head'), 'ref'),
      field(field(field(pull, 'head'), 'repo'), 'full_name'),
      field(field(pull, 'base'), 'label'),
      field(pull, 'changed_files'),
    ],
    ['integ-user:feature', 'feature', 'integ-user/repo-v1', 'integ:main', 1],
  )
  eq(
    'its files are the fork branch against the base',
    items((await send('GET', `${repo}/pulls/${number}/files`)).body).map((f) =>
      field(f, 'filename'),
    ),
    ['forked.txt'],
  )
  const graphPull = await send('POST', `${base}/graphql`, {
    query:
      `{ repository(owner: "integ", name: "repo-v1") { pullRequest(number: ${number}) { ` +
      'isCrossRepository headRefName headRepository { nameWithOwner } headRepositoryOwner { login } } } }',
  })
  eq('GraphQL agrees', field(field(field(graphPull.body, 'data'), 'repository'), 'pullRequest'), {
    isCrossRepository: true,
    headRefName: 'feature',
    headRepository: { nameWithOwner: 'integ-user/repo-v1' },
    headRepositoryOwner: { login: 'integ-user' },
  })
  eq(
    'a comparison reads `owner:branch` too',
    items(
      field((await send('GET', `${repo}/compare/main...integ-user:feature`)).body, 'files'),
    ).map((f) => field(f, 'filename')),
    ['forked.txt'],
  )
  eq(
    'a head in no fork is refused',
    field(
      (await send('POST', `${repo}/pulls`, { title: 'x', head: 'carol:feature', base: 'main' }))
        .body,
      'errors',
    ),
    [{ resource: 'PullRequest', field: 'head', code: 'invalid' }],
  )
  eq(
    "a fork's copy of an annotated tag peels through its source's tag object",
    [
      items((await send('GET', `${fork}/tags`)).body).map((t) => [
        field(t, 'name'),
        field(field(t, 'commit'), 'sha'),
      ]),
      field(
        (await send('GET', `${fork}/git/tags/${String(field(annotated.body, 'sha'))}`)).body,
        'tag',
      ),
    ],
    [[['v2', tip]], 'v2'],
  )

  // CI the fork's head commit reports to the fork rolls up on the pull request.
  const forkHead = String(field(field(pull, 'head'), 'sha'))
  await send('POST', `${fork}/statuses/${forkHead}`, { context: 'fork-ci', state: 'failure' })
  const rolled = await send('POST', `${base}/graphql`, {
    query:
      `{ repository(owner: "integ", name: "repo-v1") { pullRequest(number: ${number}) { ` +
      'commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 10) { nodes { ' +
      '... on StatusContext { context state } } } } } } } } } }',
  })
  eq(
    "a status set in the fork is on the pull request's rollup",
    field(
      field(
        (
          field(
            field(field(field(rolled.body, 'data'), 'repository'), 'pullRequest'),
            'commits',
          ) as { nodes: JsonValue[] }
        ).nodes[0] ?? null,
        'commit',
      ),
      'statusCheckRollup',
    ),
    { contexts: { nodes: [{ context: 'fork-ci', state: 'FAILURE' }] } },
  )
  eq(
    "and each repository's own status endpoint answers its own",
    [
      field((await send('GET', `${fork}/commits/${forkHead}/status`)).body, 'total_count'),
      field((await send('GET', `${repo}/commits/${forkHead}/status`)).body, 'total_count'),
    ],
    [1, 0],
  )
  for (let i = 0; i < 3; i++) {
    await send('POST', `${repo}/statuses/${forkHead}`, { context: 'shared', state: 'success' })
  }
  await send('POST', `${fork}/statuses/${forkHead}`, { context: 'shared', state: 'failure' })
  const reread = await send('POST', `${base}/graphql`, {
    query:
      `{ repository(owner: "integ", name: "repo-v1") { pullRequest(number: ${number}) { ` +
      'commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 10) { nodes { ' +
      '... on StatusContext { context state } } } } } } } } } }',
  })
  eq(
    'a context set in both repositories rolls up the one set last',
    field(
      field(
        (
          field(
            field(field(field(reread.body, 'data'), 'repository'), 'pullRequest'),
            'commits',
          ) as { nodes: JsonValue[] }
        ).nodes[0] ?? null,
        'commit',
      ),
      'statusCheckRollup',
    ),
    {
      contexts: {
        nodes: [
          { context: 'fork-ci', state: 'FAILURE' },
          { context: 'shared', state: 'FAILURE' },
        ],
      },
    },
  )

  // Deleting the source leaves the fork its history, its trees and its tags.
  const history = async (): Promise<JsonValue> =>
    items((await send('GET', `${fork}/commits?sha=feature`)).body).map((c) => field(c, 'sha'))
  const before = await history()
  const one = field(field((await send('GET', `${repo}/git/ref/heads/one`)).body, 'object'), 'sha')
  eq('the source is deleted', (await send('DELETE', repo)).status, 204)
  eq('the fork keeps its history', await history(), before)
  eq(
    "and the files of its source's commits",
    (await send('GET', `${fork}/contents/one.txt?ref=${String(one)}`)).status,
    200,
  )
  eq(
    'and its tags',
    items((await send('GET', `${fork}/tags`)).body).map((t) => field(field(t, 'commit'), 'sha')),
    [tip],
  )
  const orphaned = await send('POST', `${base}/graphql`, {
    query: '{ repository(owner: "integ-user", name: "repo-v1") { isFork parent { name } } }',
  })
  eq('with no parent left', field(field(orphaned.body, 'data'), 'repository'), {
    isFork: true,
    parent: null,
  })
}

// The git database as a client builds a commit from it and reads one back:
// one directory of a rev at any depth, with or without `recursive`; a blob
// written on its own and named by a tree; a rev walked back with `^` and
// `~<n>`; every commit rendering naming its parents and a tree id that lists
// that tree; and a Pages site's builds, one per build request and per push to
// its source branch.
async function gitDatabase(at: string): Promise<void> {
  const run = 'git-database'
  const base = `${at}/_run/${run}`
  await post(`${base}/reset`, { run, tenants: [TENANT], fixture: 'v1' })
  const repo = `${base}/repos/${REPO}`
  // A refusal has no tree, and reads as no rows rather than a crash.
  const paths = (body: JsonValue): JsonValue[] =>
    ((field(body, 'tree') ?? []) as JsonValue[]).map((it) => field(it, 'path'))

  const whole = await get(`${repo}/git/trees/main?recursive=1`)
  const under = paths(whole)
    .map(String)
    .filter((p) => p.startsWith('src/'))
    .map((p) => p.slice('src/'.length))
  const deep = await get(`${repo}/git/trees/main:src?recursive=1`)
  eq('a recursive <rev>:<dir> lists everything under it, relative', paths(deep), under)
  eq('and is whole', field(deep, 'truncated'), false)
  eq(
    'a one-level <rev>:<dir> keeps its own rows',
    paths(await get(`${repo}/git/trees/main:src`)).includes('auth/__init__.py'),
    false,
  )
  const auth = paths(await get(`${repo}/git/trees/main:src/auth`))
  eq('a nested <dir> sent with plain slashes resolves', auth.length, 9)
  eq(
    'and sent encoded, as one segment',
    paths(await get(`${repo}/git/trees/${encodeURIComponent('main:src/auth')}`)),
    auth,
  )
  eq("a missing nested <dir> is GitHub's 404", await refusal(`${repo}/git/trees/main:src/nope`), [
    404,
    'Not Found',
  ])
  eq(
    'a <dir> through a file is 422',
    await refusal(`${repo}/git/trees/main:src/auth/__init__.py`),
    [422, 'Invalid object requested. SHA must identify a commit or a tree.'],
  )
  const trunc = `${base}/repos/integ/repo-trunc/git/trees/main:src`
  const cut = await get(`${trunc}?recursive=1`)
  eq(
    'a truncated repository cuts a recursive <rev>:<dir> to its own rows',
    [field(cut, 'truncated'), paths(cut).some((p) => String(p).includes('/'))],
    [true, false],
  )
  eq('but not a one-level one', field(await get(trunc), 'truncated'), false)

  const seededTree = String(field(await get(`${repo}/git/trees/main:`), 'sha'))
  const rootSha = String(field(field(await get(`${repo}/git/ref/heads/main`), 'object'), 'sha'))
  eq(
    "a ref's tree names the commit it resolved to, and <ref>: its root tree",
    [field(await get(`${repo}/git/trees/main`), 'sha'), rootSha === seededTree],
    [rootSha, false],
  )
  eq(
    'a seeded root names the tree its branch lists',
    field(field(field(await get(`${repo}/commits/main`), 'commit'), 'tree'), 'sha'),
    seededTree,
  )
  eq(
    'and git reads it the same',
    field(field(await get(`${repo}/git/commits/${rootSha}`), 'tree'), 'sha'),
    seededTree,
  )
  eq(
    'and that id lists that tree',
    paths(await get(`${repo}/git/trees/${seededTree}?recursive=1`)),
    paths(whole),
  )
  eq('a root has no parents', field(await get(`${repo}/commits/${rootSha}`), 'parents'), [])

  const hello = await post(`${repo}/git/blobs`, { content: 'hello', encoding: 'utf-8' })
  eq(
    'a blob is written on its own',
    [hello.status, field(hello.body, 'sha')],
    [201, 'b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0'],
  )
  eq(
    'at its own url',
    field(hello.body, 'url'),
    `https://api.github.com/repos/${REPO}/git/blobs/b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0`,
  )
  eq(
    'and reads back',
    field(await get(`${repo}/git/blobs/b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0`), 'content'),
    `${Buffer.from('hello').toString('base64')}\n`,
  )
  const bytes = Buffer.from([0, 255, 1, 254])
  const binary = await post(`${repo}/git/blobs`, {
    content: bytes.toString('base64'),
    encoding: 'base64',
  })
  eq('a base64 blob is its decoded bytes', field(binary.body, 'sha'), blobSha(bytes))
  eq(
    'text is the default encoding',
    field((await post(`${repo}/git/blobs`, { content: 'hello' })).body, 'sha'),
    'b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0',
  )
  const refused = await Promise.all(
    [
      {},
      { content: 1 },
      { content: 'x', encoding: 'latin1' },
      { content: '!', encoding: 'base64' },
    ].map(async (body) => {
      const r = await post(`${repo}/git/blobs`, body)
      return [r.status, field(r.body, 'message')]
    }),
  )
  eq('a blob body it cannot read is refused', refused, [
    [422, 'Invalid request.\n\n"content" wasn\'t supplied.'],
    [422, 'Invalid request.\n\n"content" is invalid.'],
    [422, 'Invalid request.\n\n"encoding" is invalid.'],
    [422, 'Invalid request.\n\n"content" is invalid.'],
  ])
  const named = await post(`${repo}/git/trees`, {
    base_tree: seededTree,
    tree: [{ path: 'hello.txt', mode: '100644', type: 'blob', sha: field(hello.body, 'sha') }],
  })
  eq('a tree entry names the written blob', named.status, 201)
  const made = await post(`${repo}/git/commits`, {
    message: 'Add hello',
    tree: field(named.body, 'sha'),
    parents: [rootSha],
  })
  eq(
    'a commit made from it names its parent and tree',
    [
      (field(made.body, 'parents') as JsonValue[]).map((p) => field(p, 'sha')),
      field(field(made.body, 'tree'), 'sha'),
    ],
    [[rootSha], field(named.body, 'sha')],
  )
  const moved = await send('PATCH', `${repo}/git/refs/heads/main`, { sha: field(made.body, 'sha') })
  eq('the ref moves onto it', moved.status, 200)
  eq(
    'and the file is on the branch',
    Buffer.from(
      String(field(await get(`${repo}/contents/hello.txt`), 'content')),
      'base64',
    ).toString(),
    'hello',
  )
  const empty = await post(`${base}/user/repos`, { name: 'blank' })
  eq('an empty repository takes no blob', empty.status, 201)
  const blank = await post(`${base}/repos/integ-user/blank/git/blobs`, { content: 'x' })
  eq(
    'it answers 409',
    [blank.status, field(blank.body, 'message')],
    [409, 'Git Repository is empty.'],
  )

  const put = await send('PUT', `${repo}/contents/two.txt`, {
    message: 'Add two',
    content: Buffer.from('two').toString('base64'),
  })
  const first = String(field(made.body, 'sha'))
  const written = field(put.body, 'commit')
  const head = String(field(written, 'sha'))
  eq(
    'a contents write answers the git commit, with its parent',
    (field(written, 'parents') as JsonValue[]).map((p) => field(p, 'sha')),
    [first],
  )
  eq(
    'and its tree, the one git reads',
    field(field(written, 'tree'), 'sha'),
    field(field(await get(`${repo}/git/commits/${head}`), 'tree'), 'sha'),
  )
  const detail = await get(`${repo}/commits/${head}`)
  eq(
    'the REST commit names the same tree',
    field(field(field(detail, 'commit'), 'tree'), 'sha'),
    field(field(written, 'tree'), 'sha'),
  )
  eq('and links its parent there', (field(detail, 'parents') as JsonValue[])[0] ?? null, {
    sha: first,
    url: `https://api.github.com/repos/${REPO}/commits/${first}`,
    html_url: `https://github.com/${REPO}/commit/${first}`,
  })
  eq(
    'git links it among git commits',
    field(
      (field(await get(`${repo}/git/commits/${head}`), 'parents') as JsonValue[])[0] ?? null,
      'url',
    ),
    `https://api.github.com/repos/${REPO}/git/commits/${first}`,
  )
  eq(
    'every listed commit names its parents',
    ((await get(`${repo}/commits`)) as JsonValue[]).map((c) =>
      (field(c, 'parents') as JsonValue[]).map((p) => field(p, 'sha')),
    ),
    [[first], [rootSha], []],
  )
  eq(
    'a written tree id lists that tree',
    paths(await get(`${repo}/git/trees/${String(field(field(written, 'tree'), 'sha'))}`)).includes(
      'two.txt',
    ),
    true,
  )

  const shaOf = async (ref: string): Promise<JsonValue> => {
    const r = await send('GET', `${repo}/commits/${ref}`)
    return r.status === 200 ? field(r.body, 'sha') : r.status
  }
  const walked = await Promise.all(
    ['main^', 'main~1', 'main~', 'main~2', 'main^^', 'main~1^', `${head.slice(0, 7)}^`].map(shaOf),
  )
  eq('^ and ~<n> walk first parents', walked, [
    first,
    first,
    first,
    rootSha,
    rootSha,
    rootSha,
    first,
  ])
  eq(
    '^0 and ^{} name the commit itself',
    await Promise.all(['main^0', 'main~0', 'main^{}', 'main^{commit}'].map(shaOf)),
    [head, head, head, head],
  )
  eq(
    'a walk past the root, a second parent or a bare suffix names nothing',
    await Promise.all(['main~3', 'main^2', 'main^{tree}', '~1', 'nope~1'].map(shaOf)),
    [422, 422, 422, 422, 422],
  )
  const compare = await get(`${repo}/compare/${head}^...${head}`)
  eq(
    'compare reads a suffixed base',
    [
      field(compare, 'status'),
      field(compare, 'ahead_by'),
      (field(compare, 'files') as JsonValue[]).map((f) => field(f, 'filename')),
    ],
    ['ahead', 1, ['two.txt']],
  )
  eq('and a suffixed branch', field(await get(`${repo}/compare/main~2...main`), 'ahead_by'), 2)
  eq(
    "a suffixed ref reads that commit's files",
    [
      (await send('GET', `${repo}/contents/hello.txt?ref=main~1`)).status,
      (await send('GET', `${repo}/contents/two.txt?ref=main~1`)).status,
    ],
    [200, 404],
  )
  eq(
    'and lists history from it',
    ((await get(`${repo}/commits?sha=main~1`)) as JsonValue[]).map((c) => field(c, 'sha')),
    [first, rootSha],
  )
  eq('and names one directory of it', paths(await get(`${repo}/git/trees/main~2:src/auth`)), auth)

  const pages = `${repo}/pages`
  const docs = 'https://docs.github.com/rest/pages/pages#'
  const missing = await Promise.all(
    [
      ['GET', 'builds'],
      ['POST', 'builds'],
      ['GET', 'builds/latest'],
      ['GET', 'builds/1'],
    ].map(async ([method, path]) => {
      const r = await send(String(method), `${pages}/${String(path)}`)
      return [r.status, field(r.body, 'documentation_url')]
    }),
  )
  eq("without a site every build endpoint is GitHub's 404", missing, [
    [404, `${docs}list-apiname-pages-builds`],
    [404, `${docs}request-a-apiname-pages-build`],
    [404, `${docs}get-latest-pages-build`],
    [404, `${docs}get-apiname-pages-build`],
  ])
  await post(pages, { source: { branch: 'main', path: '/' } })
  const latest = await get(`${pages}/builds/latest`)
  eq(
    'a new site has been built from its source',
    [field(latest, 'status'), field(latest, 'commit'), field(field(latest, 'pusher'), 'login')],
    ['built', head, 'integ-user'],
  )
  eq('at its own url', field(latest, 'url'), `https://api.github.com/repos/${REPO}/pages/builds/1`)
  const requested = await post(`${pages}/builds`, {})
  eq(
    'a requested build is queued',
    [requested.status, requested.body],
    [201, { url: `https://api.github.com/repos/${REPO}/pages/builds/latest`, status: 'queued' }],
  )
  const pushed = await send('PUT', `${repo}/contents/three.txt`, {
    message: 'Add three',
    content: Buffer.from('three').toString('base64'),
  })
  const third = String(field(field(pushed.body, 'commit'), 'sha'))
  await post(`${repo}/git/refs`, { ref: 'refs/heads/gh-pages', sha: third })
  await send('PUT', `${repo}/contents/other.txt`, {
    message: 'Off the source',
    branch: 'gh-pages',
    content: Buffer.from('x').toString('base64'),
  })
  const builds = () =>
    get(`${pages}/builds`).then((b) =>
      (b as JsonValue[]).map((it) => [field(it, 'url'), field(it, 'commit')]),
    )
  const url = (n: number): string =>
    `https://api.github.com/repos/${REPO}/pages/builds/${String(n)}`
  eq('a push to the source branch builds again, newest first', await builds(), [
    [url(3), third],
    [url(2), head],
    [url(1), head],
  ])
  const firstPage = await send('GET', `${pages}/builds?per_page=1`)
  eq(
    'builds page like any list',
    [
      (firstPage.body as JsonValue[]).map((it) => field(it, 'url')),
      firstPage.link.includes('page=2'),
    ],
    [[url(3)], true],
  )
  eq(
    'and the next page holds the next build',
    ((await get(`${pages}/builds?per_page=1&page=2`)) as JsonValue[]).map((it) => field(it, 'url')),
    [url(2)],
  )
  eq('one build by its id', field(await get(`${pages}/builds/2`), 'commit'), head)
  eq(
    'an id it never had is 404',
    await Promise.all(
      ['9', '0', 'x'].map(async (id) => (await send('GET', `${pages}/builds/${id}`)).status),
    ),
    [404, 404, 404],
  )
  await send('PUT', pages, { source: { branch: 'gh-pages', path: '/' } })
  const ghPages = String(field(field(await get(`${repo}/git/ref/heads/gh-pages`), 'object'), 'sha'))
  eq('a new source is built from', field(await get(`${pages}/builds/latest`), 'commit'), ghPages)
  await send('DELETE', pages)
  await post(pages, { build_type: 'workflow' })
  await send('PUT', `${repo}/contents/four.txt`, {
    message: 'Add four',
    content: Buffer.from('four').toString('base64'),
  })
  eq(
    'a site a workflow publishes starts over and is not rebuilt by a push',
    (await builds()).length,
    1,
  )

  const dirId = async (): Promise<string> =>
    String(
      field(
        (field(await get(`${repo}/git/trees/main:src`), 'tree') as JsonValue[]).find(
          (it) => field(it, 'path') === 'auth',
        ) ?? null,
        'sha',
      ),
    )
  const before = await dirId()
  eq(
    'the contents API names a directory by the same tree id',
    field(
      ((await get(`${repo}/contents/src`)) as JsonValue[]).find(
        (it) => field(it, 'name') === 'auth',
      ) ?? null,
      'sha',
    ),
    before,
  )
  eq('a directory id lists that directory', paths(await get(`${repo}/git/trees/${before}`)), auth)
  await send('PUT', `${repo}/contents/src/auth/extra.py`, {
    message: 'Add extra.py',
    content: Buffer.from('x = 1\n').toString('base64'),
  })
  const after = await dirId()
  eq('a directory that changed has a new id', after === before, false)
  eq(
    'which lists what it holds now',
    paths(await get(`${repo}/git/trees/${after}`)).includes('extra.py'),
    true,
  )
  eq(
    'while the old id still lists what it held then',
    paths(await get(`${repo}/git/trees/${before}`)),
    auth,
  )
  await send('PUT', `${repo}/contents/src/auth/later.py`, {
    message: 'Add later.py',
    content: Buffer.from('z = 3\n').toString('base64'),
  })
  const kept = paths(await get(`${repo}/git/trees/${after}`))
  eq(
    'and an id no branch holds any more reads the snapshot that kept it',
    [kept.includes('extra.py'), kept.includes('later.py')],
    [true, false],
  )
  const based = await post(`${repo}/git/trees`, {
    base_tree: before,
    tree: [{ path: 'added.py', mode: '100644', type: 'blob', content: 'y = 2\n' }],
  })
  eq(
    "and a tree built on it starts from that directory, with none of the root's gitlinks",
    paths(await get(`${repo}/git/trees/${String(field(based.body, 'sha'))}`)),
    [...auth, 'added.py'].map(String).sort(),
  )

  const gitlinks = async (url: string): Promise<JsonValue[]> =>
    ((field(await get(url), 'tree') ?? []) as JsonValue[])
      .filter((it) => field(it, 'type') === 'commit')
      .map((it) => [field(it, 'path'), field(it, 'mode'), field(it, 'sha')])
  const seeded = await gitlinks(`${repo}/git/trees/main?recursive=1`)
  eq(
    'a branch lists the gitlinks its fixture seeds',
    seeded.map((row) => (row as JsonValue[])[0] ?? null),
    ['docs/vendored', 'extern'],
  )
  const link = 'c0ffee'.padEnd(40, '0')
  const linked = await post(`${repo}/git/trees`, {
    base_tree: String(field(await get(`${repo}/git/trees/main`), 'sha')),
    tree: [
      { path: 'vendor/nested/library', mode: '160000', type: 'commit', sha: link },
      { path: 'extern', mode: '160000', type: 'commit', sha: null },
    ],
  })
  const linkedTree = String(field(linked.body, 'sha'))
  const relinked = [seeded[0] ?? null, ['vendor/nested/library', '160000', link]]
  eq(
    'a commit entry is a gitlink of that tree, and a null sha drops one',
    await gitlinks(`${repo}/git/trees/${linkedTree}?recursive=1`),
    relinked,
  )
  const mainHead = String(field(field(await get(`${repo}/git/ref/heads/main`), 'object'), 'sha'))
  const linkCommit = await post(`${repo}/git/commits`, {
    message: 'Link a library',
    tree: linkedTree,
    parents: [mainHead],
  })
  await post(`${repo}/git/refs`, {
    ref: 'refs/heads/linked',
    sha: String(field(linkCommit.body, 'sha')),
  })
  eq(
    "a branch on that commit lists the commit tree's gitlinks",
    await gitlinks(`${repo}/git/trees/linked?recursive=1`),
    relinked,
  )
  const linkRoot = await get(`${repo}/git/trees/linked`)
  eq(
    'a shallow tree lists a directory containing only gitlinks',
    paths(linkRoot).includes('vendor'),
    true,
  )
  eq(
    'a recursive tree includes every gitlink-only ancestor',
    paths(await get(`${repo}/git/trees/linked?recursive=1`)).filter((path) =>
      String(path).startsWith('vendor'),
    ),
    ['vendor', 'vendor/nested', 'vendor/nested/library'],
  )
  eq(
    'a ref with a gitlink-only directory resolves',
    await gitlinks(`${repo}/git/trees/linked:vendor/nested`),
    [['library', '160000', link]],
  )
  const vendor =
    ((field(linkRoot, 'tree') ?? []) as JsonValue[]).find(
      (row) => field(row, 'path') === 'vendor',
    ) ?? null
  eq(
    'the listed gitlink-only directory id is traversable',
    paths(await get(`${repo}/git/trees/${String(field(vendor, 'sha'))}`)),
    ['nested'],
  )
  await send('PUT', `${repo}/contents/note.txt`, {
    message: 'Add note.txt',
    branch: 'linked',
    content: Buffer.from('note\n').toString('base64'),
  })
  eq(
    'and a write on the branch carries them forward',
    await gitlinks(`${repo}/git/trees/linked?recursive=1`),
    relinked,
  )
  eq('while main keeps its own', await gitlinks(`${repo}/git/trees/main?recursive=1`), seeded)

  const currentId = await dirId()
  const currentTree = await get(`${repo}/git/trees/main?recursive=1`)
  const forked = await post(`${repo}/forks`, { name: 'tree-fork' })
  eq('a repository with historical directories forks', forked.status, 202)
  const fork = `${base}/repos/integ-user/tree-fork`
  eq(
    'a fork reports the same root and directory ids as its source',
    await get(`${fork}/git/trees/main?recursive=1`),
    currentTree,
  )
  eq(
    'a fork resolves a historical directory id from its source',
    paths(await get(`${fork}/git/trees/${before}`)),
    auth,
  )
  const renamed = await send('PATCH', repo, { name: 'tree-renamed' })
  eq('a repository with indexed directory snapshots renames', renamed.status, 200)
  const movedRepo = `${base}/repos/integ/tree-renamed`
  eq(
    'a rename preserves root and directory ids',
    await get(`${movedRepo}/git/trees/main?recursive=1`),
    currentTree,
  )
  for (const target of [movedRepo, fork]) {
    eq(
      'a historical directory survives the source rename',
      paths(await get(`${target}/git/trees/${before}`)),
      auth,
    )
    const fromDirectory = await post(`${target}/git/trees`, { base_tree: before, tree: [] })
    eq(
      'a historical directory is the exact base after rename or fork',
      [fromDirectory.status, field(fromDirectory.body, 'sha')],
      [201, before],
    )
    const directoryCommit = await post(`${target}/git/commits`, {
      message: 'Commit a shared directory',
      tree: currentId,
      parents: [],
    })
    eq('a directory can be committed in either network member', directoryCommit.status, 201)
    eq(
      'the committed directory retains its own paths',
      (
        await send(
          'GET',
          `${target}/contents/extra.py?ref=${String(field(directoryCommit.body, 'sha'))}`,
        )
      ).status,
      200,
    )
  }
  const badBase = await post(`${movedRepo}/git/trees`, {
    base_tree: '0'.repeat(40),
    tree: [{ path: 'wrong.py', content: 'x = 1' }],
  })
  eq('an unknown tree base is refused instead of replaced', badBase.status, 422)
  eq('the source with indexed trees can be deleted', (await send('DELETE', movedRepo)).status, 204)
  eq(
    'a fork keeps historical directories after its source is deleted',
    paths(await get(`${fork}/git/trees/${before}`)),
    auth,
  )
  eq(
    'a fork keeps the root tree after its source is deleted',
    await get(`${fork}/git/trees/${String(field(currentTree, 'sha'))}?recursive=1`),
    currentTree,
  )
  eq(
    'the last network member deletes its directory index',
    (await send('DELETE', fork)).status,
    204,
  )
}

async function indexedTrees(): Promise<void> {
  const home = await start(githubFake, 0)
  const run = 'indexed-trees'
  let db: PrismaClient | undefined
  try {
    await home.runtime.reset({ run, tenants: [TENANT], fixture: 'v1' })
    const measured = new PrismaClient({
      datasourceUrl: `file:${home.runtime.pool.fileFor(run)}`,
      log: [{ emit: 'event', level: 'query' }],
    })
    db = measured
    let queries = 0
    measured.$on('query', () => {
      queries += 1
    })
    const repo = await repoByName(measured, TENANT, REPO)
    if (repo === null) throw new Error('indexed trees fixture has no repository')
    const old = new Map([['archive/deep/old.txt', Buffer.from('old snapshot')]])
    const root = await stageTree(measured, TENANT, repo, old, new Map())
    const directory = directoryIds(old, new Map()).get('archive') ?? ''
    const lookup = async (): Promise<number> => {
      queries = 0
      const hit = await treeById(measured, TENANT, repo, directory)
      const count = queries
      eq(
        'an indexed historical directory loads its original bytes',
        hit === null
          ? null
          : [...subtreeOf(hit, hit.at).files].map(([path, data]) => [path, data.toString()]),
        [['deep/old.txt', 'old snapshot']],
      )
      return count
    }
    const short = await lookup()
    for (let i = 0; i < 24; i += 1) {
      await stageTree(
        measured,
        TENANT,
        repo,
        new Map([['archive/new.txt', Buffer.from(String(i))]]),
        new Map(),
      )
    }
    const long = await lookup()
    check(
      'historical lookup query count stays bounded as snapshots grow',
      short === long && long <= 3,
      `${short} -> ${long}`,
    )

    const base = `${home.endpoint}/_run/${run}`
    const created = await post(`${base}/user/repos`, { name: 'unrelated-trees' })
    eq('an unrelated repository is created', created.status, 201)
    const other = await repoByName(measured, TENANT, 'integ-user/unrelated-trees')
    if (other === null) throw new Error('unrelated repository was not created')
    eq(
      'a directory is not visible outside its network',
      (await treeById(measured, TENANT, other, directory)) === null,
      true,
    )
    eq(
      'an unrelated repository stores identical content without a collision',
      await stageTree(measured, TENANT, other, old, new Map()),
      root,
    )
    const duplicate = await treeById(measured, TENANT, other, directory)
    eq(
      'its directory resolves in its own network',
      duplicate?.files.get('archive/deep/old.txt')?.toString() ?? null,
      'old snapshot',
    )
    eq(
      'deleting one copy of a tree succeeds',
      (await send('DELETE', `${base}/repos/${REPO}`)).status,
      204,
    )
    const retained = await treeById(measured, TENANT, other, directory)
    eq(
      'deletion preserves identical objects in unrelated repositories',
      retained?.files.get('archive/deep/old.txt')?.toString() ?? null,
      'old snapshot',
    )
    await post(`${base}/reset`, { run, tenants: [TENANT], fixture: 'v1' })
    eq(
      'reset removes every directory index row',
      await measured.githubStagedDir.count({ where: { tenant: TENANT } }),
      0,
    )
  } finally {
    await db?.$disconnect()
    await home.close()
  }
}

async function main(): Promise<void> {
  const fake = await launch()
  const at = fake.endpoint
  try {
    await refIdentity(at)
    await reviewAncestry(at)
    await mergeHistory(at)
    await emptyRepository(at)
    await seededHistory(at)
    await supersededBlobs(at)
    await refsNameCommits(at)
    await abandonedRoot(at)
    await gitDatabase(at)
    await indexedTrees()
    await workflowsAndSettings(at)
    await diffsSearchAndHistory(at)
    await diffsMatchGit()
    await listsProfilesAndForks(at)
    const reset = await fetch(`${at}/reset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tenants: [TENANT], fixture: 'v1' }),
    })
    check('/reset seeds the fixture', reset.status === 200, String(reset.status))

    // ---- `{ref}:{dir}` lists one directory, as GitHub's rev syntax does; the
    // point lookup sends it percent-encoded as one segment, and python's
    // client sends the colon raw
    const shallow = async (segment: string): Promise<{ status: number; body: JsonValue }> => {
      const r = await fetch(`${at}/repos/${REPO}/git/trees/${segment}`, { headers: HEADERS })
      return { status: r.status, body: (await r.json()) as JsonValue }
    }
    // docs/vendored is a submodule: GitHub lists a gitlink in a tree, and the
    // client is what drops it.
    const names = (body: JsonValue): JsonValue[] =>
      (field(body, 'tree') as JsonValue[]).map((row) => field(row, 'path'))
    const docs = await shallow('main%3Adocs')
    eq('an encoded ref:dir lists that directory', names(docs.body), [
      'architecture.md',
      'contributing.md',
      'release.md',
      'vendored',
    ])
    eq('a raw colon lists the same rows', names((await shallow('main:docs')).body), [
      'architecture.md',
      'contributing.md',
      'release.md',
      'vendored',
    ])
    eq(
      'an encoded slash reaches a nested directory',
      names((await shallow('main%3Asrc%2Fcache')).body).length,
      9,
    )
    eq('a path through a file is 422', (await shallow('main%3AREADME.md')).status, 422)
    eq('a missing directory is 404', (await shallow('main%3Anope')).status, 404)
    eq('an unknown ref is 404', (await shallow('gone%3Adocs')).status, 404)
    // A bare ref without recursive names only the root's own rows, uncut: the
    // truncated repository's per-directory walk asks for its root this way.
    const bareRoot = await get(`${at}/repos/integ/repo-trunc/git/trees/main`)
    eq('a bare ref lists the root shallow and whole', field(bareRoot, 'truncated'), false)
    check(
      'a bare ref lists no nested path',
      (field(bareRoot, 'tree') as JsonValue[]).every(
        (row) => !String(field(row, 'path')).includes('/'),
      ),
    )
    const whole = await get(`${at}/repos/${REPO}/git/trees/main?recursive=1`)
    const wholeRow = (field(whole, 'tree') as JsonValue[]).find(
      (row) => field(row, 'path') === 'docs/release.md',
    )
    const pointRow = (field(docs.body, 'tree') as JsonValue[]).find(
      (row) => field(row, 'path') === 'release.md',
    )
    eq(
      "a listed row carries the recursive tree row's sha",
      field(pointRow ?? null, 'sha'),
      field(wholeRow ?? null, 'sha'),
    )
    check('vanilla gh search matches Mirage', (await searchConformance(at)) > 0)

    // ---- an author the caller states is the author the fake keeps
    const t1 = await stage(at, 'tasks/one.md', '# one\n')
    const made = await post(`${at}/repos/${REPO}/git/commits`, {
      message: 'Add task one',
      tree: t1,
      author: AUTHOR,
    })
    check('a commit is created', made.status === 201, String(made.status))
    eq('the response echoes the author verbatim', field(made.body, 'author'), AUTHOR)

    // The offset is the point. Normalizing it to UTC would answer the same
    // instant spelled differently, and a fixture that pinned +08:00 would read
    // back as something it did not write.
    const author = field(made.body, 'author')
    check(
      'the pinned offset survives',
      String(field(author, 'date')) === '2025-09-02T09:00:00+08:00',
      String(field(author, 'date')),
    )
    eq('a missing committer defaults to the author', field(made.body, 'committer'), AUTHOR)

    // ---- and it survives the round trip, which is what a reader sees
    const sha = String(field(made.body, 'sha') ?? '')
    const read = await get(`${at}/repos/${REPO}/git/commits/${sha}`)
    eq('GET /git/commits/:sha reports the author', field(read, 'author'), AUTHOR)
    eq('and the committer', field(read, 'committer'), AUTHOR)

    // ---- a commit exists before any ref names it, and until one does it is
    // on no branch's history, which is what "dangling" means: readable by sha,
    // absent from every list.
    const beforeAttach = await get(`${at}/repos/${REPO}/commits`)
    check(
      'a commit no ref names is not on a branch',
      Array.isArray(beforeAttach) && !beforeAttach.some((c) => String(field(c, 'sha')) === sha),
      sha,
    )

    // ---- the list endpoint, which is what "most recent commits" reads, once
    // the ref has been pointed at the commit
    const trunk = String(field(await get(`${at}/repos/${REPO}`), 'default_branch'))
    const attach = await fetch(`${at}/repos/${REPO}/git/refs/heads/${trunk}`, {
      method: 'PATCH',
      headers: HEADERS,
      body: JSON.stringify({ sha }),
    })
    check('the default ref takes the commit', attach.status === 200, String(attach.status))
    const listed = await get(`${at}/repos/${REPO}/commits`)
    const top = Array.isArray(listed) ? (listed[0] ?? null) : null
    eq('the commit list carries the author', field(field(top, 'commit'), 'author'), AUTHOR)

    // ---- a committer distinct from the author is kept distinct
    const t2 = await stage(at, 'tasks/two.md', '# two\n')
    const two = await post(`${at}/repos/${REPO}/git/commits`, {
      message: 'Add task two',
      tree: t2,
      author: AUTHOR,
      committer: { name: 'Sam Iyer', email: 'sam@example.com', date: '2025-09-03T11:30:00+08:00' },
    })
    eq('a distinct committer is kept', field(two.body, 'committer'), {
      name: 'Sam Iyer',
      email: 'sam@example.com',
      date: '2025-09-03T11:30:00+08:00',
    })
    eq('and does not overwrite the author', field(two.body, 'author'), AUTHOR)

    // ---- an author naming only a date still gets a whole person
    const t3 = await stage(at, 'tasks/three.md', '# three\n')
    const dated = await post(`${at}/repos/${REPO}/git/commits`, {
      message: 'Add task three',
      tree: t3,
      author: { date: '2025-09-04T08:00:00Z' },
    })
    eq('a date-only author is filled out', field(dated.body, 'author'), {
      name: 'integ-user',
      email: 'integ-user@users.noreply.github.com',
      date: '2025-09-04T08:00:00Z',
    })

    // ---- a commit that names nobody is unchanged, which is what the goldens
    // record: the author blocks are absent, not empty.
    const t4 = await stage(at, 'tasks/four.md', '# four\n')
    const bare = await post(`${at}/repos/${REPO}/git/commits`, { message: 'Add four', tree: t4 })
    check('a commit naming nobody has no author', field(bare.body, 'author') === null, 'absent')
    check(
      'and no committer',
      field(bare.body, 'committer') === null,
      String(field(bare.body, 'committer')),
    )

    // ---- a malformed author is refused rather than read as absent
    const t5 = await stage(at, 'tasks/five.md', '# five\n')
    const bad = await post(`${at}/repos/${REPO}/git/commits`, {
      message: 'Add five',
      tree: t5,
      author: 'Dana Wu <dana@example.com>',
    })
    check('a non-object author is 422', bad.status === 422, String(bad.status))
    const badc = await post(`${at}/repos/${REPO}/git/commits`, {
      message: 'Add five',
      tree: t5,
      committer: ['Dana Wu'],
    })
    check('a non-object committer is 422', badc.status === 422, String(badc.status))

    // ---- a committer without an author keeps the committer, and the author
    // fills with the endpoint's default identity rather than vanishing
    const tSolo = await stage(at, 'tasks/solo.md', '# solo\n')
    const solo = await post(`${at}/repos/${REPO}/git/commits`, {
      message: 'Add solo',
      tree: tSolo,
      committer: { name: 'Sam Iyer', email: 'sam@example.com', date: '2025-09-05T09:15:00+08:00' },
    })
    eq('a committer alone is kept', field(solo.body, 'committer'), {
      name: 'Sam Iyer',
      email: 'sam@example.com',
      date: '2025-09-05T09:15:00+08:00',
    })
    eq('and the author fills with the default identity', field(solo.body, 'author'), {
      name: 'integ-user',
      email: 'integ-user@users.noreply.github.com',
      date: '2026-01-01T00:00:00Z',
    })

    // ---- pointing a ref at a commit is what puts it on that branch's
    // history: a client that builds history stages a tree, creates the
    // commit, and PATCHes the ref, and the branch's commit list has to grow
    // by exactly that commit. The move is a move, not a copy: a commit a ref
    // took to a branch does not stay on the default branch's history.
    const mainBefore = await get(`${at}/repos/${REPO}/commits`)
    const mainCount = Array.isArray(mainBefore) ? mainBefore.length : 0
    const made6 = await post(`${at}/repos/${REPO}/git/refs`, {
      ref: 'refs/heads/task-1',
      sha: '',
    })
    check('a branch is created', made6.status === 201, String(made6.status))
    const branchBefore = await get(`${at}/repos/${REPO}/commits?sha=task-1`)
    const branchCount = Array.isArray(branchBefore) ? branchBefore.length : 0
    const t6 = await stage(at, 'tasks/six.md', '# six\n')
    const six = await post(`${at}/repos/${REPO}/git/commits`, {
      message: 'Add task six',
      tree: t6,
      author: AUTHOR,
    })
    const sha6 = String(field(six.body, 'sha') ?? '')
    const moved = await fetch(`${at}/repos/${REPO}/git/refs/heads/task-1`, {
      method: 'PATCH',
      headers: HEADERS,
      body: JSON.stringify({ sha: sha6 }),
    })
    check('the ref moves', moved.status === 200, String(moved.status))
    const branchAfter = await get(`${at}/repos/${REPO}/commits?sha=task-1`)
    const rows = Array.isArray(branchAfter) ? branchAfter : []
    check(
      'the branch history grows by one',
      rows.length === branchCount + 1,
      `got ${String(rows.length)} want ${String(branchCount + 1)}`,
    )
    check('and its head is the commit the ref took', String(field(rows[0] ?? null, 'sha')) === sha6)
    eq(
      'with the message the commit stated',
      field(field(rows[0] ?? null, 'commit'), 'message'),
      'Add task six',
    )
    eq(
      'and the author it stated',
      field(field(field(rows[0] ?? null, 'commit'), 'author'), 'date'),
      AUTHOR.date,
    )
    const mainAfter = await get(`${at}/repos/${REPO}/commits`)
    check(
      'the default branch does not keep it',
      Array.isArray(mainAfter) && mainAfter.length === mainCount,
      `got ${String(Array.isArray(mainAfter) ? mainAfter.length : -1)} want ${String(mainCount)}`,
    )
    const read6 = await get(`${at}/repos/${REPO}/git/commits/${sha6}`)
    eq('GET /git/commits/:sha still answers after the move', field(read6, 'sha'), sha6)

    // ---- the moved commit freed its sequence on the default branch, so a
    // later commit reusing that sequence AND the message must still get its
    // own sha, or a ref update resolving the sha publishes the wrong tree.
    const t7 = await stage(at, 'tasks/seven.md', '# seven\n')
    const seven = await post(`${at}/repos/${REPO}/git/commits`, {
      message: 'Add task six',
      tree: t7,
    })
    check(
      'a same-message commit after the move gets its own sha',
      String(field(seven.body, 'sha')) !== sha6,
      sha6,
    )

    // ---- a second ref pointing at the same commit shares it: git commits
    // are reachable from many refs, so attaching one to another branch copies
    // it onto that history rather than stealing it from the first.
    await post(`${at}/repos/${REPO}/git/refs`, { ref: 'refs/heads/task-2', sha: '' })
    const shared = await fetch(`${at}/repos/${REPO}/git/refs/heads/task-2`, {
      method: 'PATCH',
      headers: HEADERS,
      body: JSON.stringify({ sha: sha6 }),
    })
    check('a second ref takes the same commit', shared.status === 200, String(shared.status))
    const firstList = await get(`${at}/repos/${REPO}/commits?sha=task-1`)
    check(
      'the first branch keeps it',
      Array.isArray(firstList) && String(field(firstList[0] ?? null, 'sha')) === sha6,
      String(field((Array.isArray(firstList) ? firstList[0] : null) ?? null, 'sha')),
    )
    const secondList = await get(`${at}/repos/${REPO}/commits?sha=task-2`)
    check(
      'and the second branch gains it',
      Array.isArray(secondList) && String(field(secondList[0] ?? null, 'sha')) === sha6,
      String(field((Array.isArray(secondList) ? secondList[0] : null) ?? null, 'sha')),
    )

    // ---- resetting a branch to an older commit is a forced update: refused
    // without `force`, and with it the requested commit becomes the head and
    // the discarded one leaves the branch's history.
    const t8 = await stage(at, 'tasks/eight.md', '# eight\n')
    const eight = await post(`${at}/repos/${REPO}/git/commits`, {
      message: 'Add task eight',
      tree: t8,
      parents: [sha6],
    })
    const sha8 = String(field(eight.body, 'sha') ?? '')
    const advance = await fetch(`${at}/repos/${REPO}/git/refs/heads/task-1`, {
      method: 'PATCH',
      headers: HEADERS,
      body: JSON.stringify({ sha: sha8 }),
    })
    check(
      'a commit stating its parent advances the ref unforced',
      advance.status === 200,
      String(advance.status),
    )
    const soft = await fetch(`${at}/repos/${REPO}/git/refs/heads/task-1`, {
      method: 'PATCH',
      headers: HEADERS,
      body: JSON.stringify({ sha: sha6 }),
    })
    check('a backward update without force is refused', soft.status === 422, String(soft.status))
    const heldRef = await get(`${at}/repos/${REPO}/git/ref/heads/task-1`)
    eq('and the head is unchanged', field(field(heldRef, 'object'), 'sha'), sha8)
    const forced = await fetch(`${at}/repos/${REPO}/git/refs/heads/task-1`, {
      method: 'PATCH',
      headers: HEADERS,
      body: JSON.stringify({ sha: sha6, force: true }),
    })
    check('a forced backward update lands', forced.status === 200, String(forced.status))
    const resetRef = await get(`${at}/repos/${REPO}/git/ref/heads/task-1`)
    eq('the head is the requested commit', field(field(resetRef, 'object'), 'sha'), sha6)
    const resetList = await get(`${at}/repos/${REPO}/commits?sha=task-1`)
    check(
      'and the discarded commit left the history',
      Array.isArray(resetList) && !resetList.some((c) => String(field(c, 'sha')) === sha8),
      sha8,
    )
    // Abandoned, not destroyed: nothing points at it, and it still answers,
    // which is what the vendor does with a dangling commit.
    const dangling = await get(`${at}/repos/${REPO}/git/commits/${sha8}`)
    eq('the abandoned commit is still readable by sha', field(dangling, 'sha'), sha8)

    // ---- two commits telling the same tree and message apart only by their
    // author are two commits, even when a move freed the first one's sequence.
    const t9 = await stage(at, 'tasks/nine.md', '# nine\n')
    const nineA = await post(`${at}/repos/${REPO}/git/commits`, {
      message: 'Add task nine',
      tree: t9,
      author: AUTHOR,
    })
    const sha9a = String(field(nineA.body, 'sha') ?? '')
    await post(`${at}/repos/${REPO}/git/refs`, { ref: 'refs/heads/task-3', sha: '' })
    await fetch(`${at}/repos/${REPO}/git/refs/heads/task-3`, {
      method: 'PATCH',
      headers: HEADERS,
      body: JSON.stringify({ sha: sha9a }),
    })
    const nineB = await post(`${at}/repos/${REPO}/git/commits`, {
      message: 'Add task nine',
      tree: t9,
      author: { name: 'Sam Iyer', email: 'sam@example.com', date: '2025-09-06T10:00:00+08:00' },
    })
    check(
      'a same-tree same-message commit by another author gets its own sha',
      String(field(nineB.body, 'sha')) !== sha9a,
      sha9a,
    )

    // ---- a reset is a reset even when the requested commit's row lives on
    // another branch: it is older than the branch's commits, so the update is
    // not a fast forward, and forcing it discards the newer commits without
    // taking anything from the branch that holds the requested one.
    const tK = await stage(at, 'tasks/ten.md', '# ten\n')
    const ten = await post(`${at}/repos/${REPO}/git/commits`, {
      message: 'Add task ten',
      tree: tK,
    })
    const shaK = String(field(ten.body, 'sha') ?? '')
    await post(`${at}/repos/${REPO}/git/refs`, { ref: 'refs/heads/task-4', sha: '' })
    await fetch(`${at}/repos/${REPO}/git/refs/heads/task-4`, {
      method: 'PATCH',
      headers: HEADERS,
      body: JSON.stringify({ sha: shaK }),
    })
    const crossSoft = await fetch(`${at}/repos/${REPO}/git/refs/heads/task-4`, {
      method: 'PATCH',
      headers: HEADERS,
      body: JSON.stringify({ sha: sha6 }),
    })
    check(
      'a cross-branch backward update without force is refused',
      crossSoft.status === 422,
      String(crossSoft.status),
    )
    const crossForced = await fetch(`${at}/repos/${REPO}/git/refs/heads/task-4`, {
      method: 'PATCH',
      headers: HEADERS,
      body: JSON.stringify({ sha: sha6, force: true }),
    })
    check('and lands when forced', crossForced.status === 200, String(crossForced.status))
    const crossRef = await get(`${at}/repos/${REPO}/git/ref/heads/task-4`)
    eq(
      'the head is the requested commit after the reset',
      field(field(crossRef, 'object'), 'sha'),
      sha6,
    )
    const crossList = await get(`${at}/repos/${REPO}/commits?sha=task-4`)
    check(
      'the newer commit left the reset branch',
      Array.isArray(crossList) && !crossList.some((c) => String(field(c, 'sha')) === shaK),
      shaK,
    )
    const donorList = await get(`${at}/repos/${REPO}/commits?sha=task-1`)
    check(
      'and the branch holding the commit keeps it',
      Array.isArray(donorList) && String(field(donorList[0] ?? null, 'sha')) === sha6,
      String(field((Array.isArray(donorList) ? donorList[0] : null) ?? null, 'sha')),
    )

    // ---- a client may prepare several commits before touching any ref. Each
    // states the one it builds on, so the two form a chain and attaching them
    // in turn is an ordinary fast forward, however long the ref sat still.
    const trunkHead = String(
      field(field(await get(`${at}/repos/${REPO}/git/ref/heads/${trunk}`), 'object'), 'sha'),
    )
    const tw = await stage(at, 'tasks/twelve.md', '# twelve\n')
    const twelve = await post(`${at}/repos/${REPO}/git/commits`, {
      message: 'Add task twelve',
      tree: tw,
      parents: [trunkHead],
    })
    const shaTw = String(field(twelve.body, 'sha') ?? '')
    const th = await stage(at, 'tasks/thirteen.md', '# thirteen\n')
    const thirteen = await post(`${at}/repos/${REPO}/git/commits`, {
      message: 'Add task thirteen',
      tree: th,
      parents: [shaTw],
    })
    const shaTh = String(field(thirteen.body, 'sha') ?? '')
    const parked1 = await fetch(`${at}/repos/${REPO}/git/refs/heads/${trunk}`, {
      method: 'PATCH',
      headers: HEADERS,
      body: JSON.stringify({ sha: shaTw }),
    })
    check(
      'attaching a prepared commit needs no force with another prepared above',
      parked1.status === 200,
      String(parked1.status),
    )
    const trunkRef1 = await get(`${at}/repos/${REPO}/git/ref/heads/${trunk}`)
    eq('and the ref reports it', field(field(trunkRef1, 'object'), 'sha'), shaTw)
    const parked2 = await fetch(`${at}/repos/${REPO}/git/refs/heads/${trunk}`, {
      method: 'PATCH',
      headers: HEADERS,
      body: JSON.stringify({ sha: shaTh }),
    })
    check(
      'attaching the second prepared commit advances',
      parked2.status === 200,
      String(parked2.status),
    )
    const trunkRef2 = await get(`${at}/repos/${REPO}/git/ref/heads/${trunk}`)
    eq('and the ref reports the advance', field(field(trunkRef2, 'object'), 'sha'), shaTh)
    const wholeChain = await get(`${at}/repos/${REPO}/commits`)
    check(
      'the branch lists the whole chain it was walked onto',
      Array.isArray(wholeChain) &&
        wholeChain.some((c) => String(field(c, 'sha')) === shaTh) &&
        wholeChain.some((c) => String(field(c, 'sha')) === shaTw),
      String(Array.isArray(wholeChain) ? wholeChain.length : -1),
    )

    // ---- a commit that does NOT build on the head is a divergence, not an
    // advance, so pointing the ref at it is forced even though it is the
    // newest thing in the repository. This is the difference stated parents
    // buy: order of creation is not ancestry.
    const ts = await stage(at, 'tasks/sibling.md', '# sibling\n')
    const sibling = await post(`${at}/repos/${REPO}/git/commits`, {
      message: 'Add a sibling',
      tree: ts,
      parents: [shaTw],
    })
    const shaSib = String(field(sibling.body, 'sha') ?? '')
    const diverge = await fetch(`${at}/repos/${REPO}/git/refs/heads/${trunk}`, {
      method: 'PATCH',
      headers: HEADERS,
      body: JSON.stringify({ sha: shaSib }),
    })
    check('a divergent sibling is refused unforced', diverge.status === 422, String(diverge.status))
    const forcedSib = await fetch(`${at}/repos/${REPO}/git/refs/heads/${trunk}`, {
      method: 'PATCH',
      headers: HEADERS,
      body: JSON.stringify({ sha: shaSib, force: true }),
    })
    check('and lands when forced', forcedSib.status === 200, String(forcedSib.status))

    // ---- a /contents write advanced its ref the moment it landed, so it is
    // attached history: a backward PATCH past it is forced, and forcing
    // discards it like any other commit the reset abandons.
    const tF = await stage(at, 'tasks/fourteen.md', '# fourteen\n')
    const fourteen = await post(`${at}/repos/${REPO}/git/commits`, {
      message: 'Add task fourteen',
      tree: tF,
    })
    const shaF = String(field(fourteen.body, 'sha') ?? '')
    await post(`${at}/repos/${REPO}/git/refs`, { ref: 'refs/heads/task-5', sha: '' })
    await fetch(`${at}/repos/${REPO}/git/refs/heads/task-5`, {
      method: 'PATCH',
      headers: HEADERS,
      body: JSON.stringify({ sha: shaF }),
    })
    const put = await fetch(`${at}/repos/${REPO}/contents/tasks/fifteen.md`, {
      method: 'PUT',
      headers: HEADERS,
      body: JSON.stringify({
        message: 'Add fifteen via contents',
        content: Buffer.from('# fifteen\n').toString('base64'),
        branch: 'task-5',
      }),
    })
    check('a contents write lands on the branch', put.status === 201, String(put.status))
    const pastSoft = await fetch(`${at}/repos/${REPO}/git/refs/heads/task-5`, {
      method: 'PATCH',
      headers: HEADERS,
      body: JSON.stringify({ sha: shaF }),
    })
    check(
      'a backward PATCH past a contents commit is refused without force',
      pastSoft.status === 422,
      String(pastSoft.status),
    )
    const pastForced = await fetch(`${at}/repos/${REPO}/git/refs/heads/task-5`, {
      method: 'PATCH',
      headers: HEADERS,
      body: JSON.stringify({ sha: shaF, force: true }),
    })
    check('and lands when forced', pastForced.status === 200, String(pastForced.status))
    const pastRef = await get(`${at}/repos/${REPO}/git/ref/heads/task-5`)
    eq('the ref reports the reset commit', field(field(pastRef, 'object'), 'sha'), shaF)
    const pastList = await get(`${at}/repos/${REPO}/commits?sha=task-5`)
    check(
      'and the contents commit left the history',
      Array.isArray(pastList) &&
        !pastList.some(
          (c) => String(field(field(c, 'commit'), 'message')) === 'Add fifteen via contents',
        ),
      'Add fifteen via contents',
    )

    // ---- a /contents write after a forced reset cannot reproduce the sha of
    // the commit the reset abandoned: the address covers the bytes, so the
    // same message on the same parent with different content is a different
    // commit.
    await post(`${at}/repos/${REPO}/git/refs`, { ref: 'refs/heads/task-6', sha: '' })
    const base6 = String(
      field(field(await get(`${at}/repos/${REPO}/git/ref/heads/task-6`), 'object'), 'sha'),
    )
    const w1 = await fetch(`${at}/repos/${REPO}/contents/tasks/reused.md`, {
      method: 'PUT',
      headers: HEADERS,
      body: JSON.stringify({
        message: 'One message',
        content: Buffer.from('first\n').toString('base64'),
        branch: 'task-6',
      }),
    })
    const firstSha = String(field(field(await w1.json(), 'commit'), 'sha'))
    if (base6 !== '') {
      await fetch(`${at}/repos/${REPO}/git/refs/heads/task-6`, {
        method: 'PATCH',
        headers: HEADERS,
        body: JSON.stringify({ sha: base6, force: true }),
      })
    }
    const w2 = await fetch(`${at}/repos/${REPO}/contents/tasks/reused.md`, {
      method: 'PUT',
      headers: HEADERS,
      body: JSON.stringify({
        message: 'One message',
        content: Buffer.from('second, different bytes\n').toString('base64'),
        branch: 'task-6',
      }),
    })
    const secondSha = String(field(field(await w2.json(), 'commit'), 'sha'))
    check(
      'a contents commit after a reset cannot reuse an abandoned sha',
      firstSha !== secondSha && secondSha !== '',
      `${firstSha} vs ${secondSha}`,
    )

    // ---- a commit prepared before the branch moved on is stale: the ref has
    // advanced through /contents since, so pointing back at it is a reset and
    // needs force, whatever order the two were created in.
    const tStale = await stage(at, 'tasks/stale.md', '# stale\n')
    const staleHead = String(
      field(field(await get(`${at}/repos/${REPO}/git/ref/heads/task-6`), 'object'), 'sha'),
    )
    const stale = await post(`${at}/repos/${REPO}/git/commits`, {
      message: 'Prepared before the write',
      tree: tStale,
      parents: [staleHead],
    })
    const shaStale = String(field(stale.body, 'sha') ?? '')
    await fetch(`${at}/repos/${REPO}/contents/tasks/after.md`, {
      method: 'PUT',
      headers: HEADERS,
      body: JSON.stringify({
        message: 'Written after the commit was prepared',
        content: Buffer.from('after\n').toString('base64'),
        branch: 'task-6',
      }),
    })
    const staleSoft = await fetch(`${at}/repos/${REPO}/git/refs/heads/task-6`, {
      method: 'PATCH',
      headers: HEADERS,
      body: JSON.stringify({ sha: shaStale }),
    })
    check(
      'a stale prepared commit is refused once a contents write moved the ref',
      staleSoft.status === 422,
      String(staleSoft.status),
    )
    const staleForced = await fetch(`${at}/repos/${REPO}/git/refs/heads/task-6`, {
      method: 'PATCH',
      headers: HEADERS,
      body: JSON.stringify({ sha: shaStale, force: true }),
    })
    check('and lands when forced', staleForced.status === 200, String(staleForced.status))

    // ---- a branch can be created directly at a commit no ref names yet,
    // which is the two-step a client takes when it builds a branch from
    // scratch: commit, then point a new ref at it. The branch starts at that
    // commit and carries its tree, rather than inheriting some other ref's.
    const tN = await stage(at, 'tasks/newbranch.md', '# new branch\n')
    const newborn = await post(`${at}/repos/${REPO}/git/commits`, {
      message: 'Commit for a branch that does not exist yet',
      tree: tN,
    })
    const shaN = String(field(newborn.body, 'sha') ?? '')
    const atCommit = await post(`${at}/repos/${REPO}/git/refs`, {
      ref: 'refs/heads/task-7',
      sha: shaN,
    })
    check(
      'a ref can be created at a dangling commit',
      atCommit.status === 201,
      String(atCommit.status),
    )
    eq('and the new ref reports that commit', field(field(atCommit.body, 'object'), 'sha'), shaN)
    const bornRef = await get(`${at}/repos/${REPO}/git/ref/heads/task-7`)
    eq('which survives a re-read', field(field(bornRef, 'object'), 'sha'), shaN)
    const bornList = await get(`${at}/repos/${REPO}/commits?sha=task-7`)
    check(
      'the branch history starts at that commit',
      Array.isArray(bornList) && String(field(bornList[0] ?? null, 'sha')) === shaN,
      String(field((Array.isArray(bornList) ? bornList[0] : null) ?? null, 'sha')),
    )
    const bornFile = await fetch(`${at}/repos/${REPO}/contents/tasks/newbranch.md?ref=task-7`, {
      headers: HEADERS,
    })
    check("and carries that commit's tree", bornFile.status === 200, String(bornFile.status))

    // ---- a seeded branch carries files and no stored commit, and the ref
    // endpoint answers for it with a synthesized root. That root is the ref's
    // position, so it is what a first update is judged against: a commit that
    // does not build on it would discard the seeded tree, which is a reset.
    const reseed = await fetch(`${at}/reset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tenants: [TENANT], fixture: 'v1' }),
    })
    check('the fixture is seeded again', reseed.status === 200, String(reseed.status))
    const seededRoot = String(
      field(field(await get(`${at}/repos/${REPO}/git/ref/heads/${trunk}`), 'object'), 'sha'),
    )
    check('a seeded branch answers with a root commit', seededRoot !== '', seededRoot)

    // A commit that states no parent at all is a root commit, which is what an
    // empty `parents` means: it is not the absent field, and it must not be
    // quietly re-parented onto the branch head.
    const tR = await stage(at, 'tasks/rootish.md', '# rootish\n')
    const rootish = await post(`${at}/repos/${REPO}/git/commits`, {
      message: 'A root commit',
      tree: tR,
      parents: [],
    })
    const shaRootish = String(field(rootish.body, 'sha') ?? '')
    const implied = await post(`${at}/repos/${REPO}/git/commits`, {
      message: 'A root commit',
      tree: tR,
    })
    check(
      'an empty parents list is not the same commit as an absent one',
      String(field(implied.body, 'sha')) !== shaRootish,
      `${shaRootish} vs ${String(field(implied.body, 'sha'))}`,
    )

    const overwrite = await fetch(`${at}/repos/${REPO}/git/refs/heads/${trunk}`, {
      method: 'PATCH',
      headers: HEADERS,
      body: JSON.stringify({ sha: shaRootish }),
    })
    check(
      'a commit that does not build on the seeded root is refused',
      overwrite.status === 422,
      String(overwrite.status),
    )
    const keptRef = await get(`${at}/repos/${REPO}/git/ref/heads/${trunk}`)
    eq(
      'and the branch still answers with its root',
      field(field(keptRef, 'object'), 'sha'),
      seededRoot,
    )

    // The same update, from a commit that DOES build on that root, is an
    // ordinary advance: this is the flow every client takes on a fresh repo.
    const onRoot = await post(`${at}/repos/${REPO}/git/commits`, {
      message: 'Built on the seeded root',
      tree: tR,
      parents: [seededRoot],
    })
    const shaOnRoot = String(field(onRoot.body, 'sha') ?? '')
    const advanced = await fetch(`${at}/repos/${REPO}/git/refs/heads/${trunk}`, {
      method: 'PATCH',
      headers: HEADERS,
      body: JSON.stringify({ sha: shaOnRoot }),
    })
    check(
      'a commit built on the root advances unforced',
      advanced.status === 200,
      String(advanced.status),
    )
    const forcedOver = await fetch(`${at}/repos/${REPO}/git/refs/heads/${trunk}`, {
      method: 'PATCH',
      headers: HEADERS,
      body: JSON.stringify({ sha: shaRootish, force: true }),
    })
    check(
      'and the refused one lands when forced',
      forcedOver.status === 200,
      String(forcedOver.status),
    )

    // ---- a commit created with `parents: []` IS a root, so a branch standing
    // on it stands on nothing further. The synthesized root is the floor for a
    // chain that never reaches one of its own, not a parent stapled under
    // every history.
    const rootedList = await get(`${at}/repos/${REPO}/commits?sha=${trunk}`)
    check(
      'a stored root commit is the end of its branch history',
      Array.isArray(rootedList) &&
        rootedList.length === 1 &&
        String(field(rootedList[0] ?? null, 'sha')) === shaRootish,
      String(Array.isArray(rootedList) ? rootedList.length : -1),
    )

    // ---- a commit written through /contents is an object like any other, so
    // a ref can be pointed at it. It reached the branch by advancing the ref,
    // which is the one thing that used to make it unnameable: it carried no
    // staged tree, and the ref endpoint read a missing tree as a missing
    // commit.
    await post(`${at}/repos/${REPO}/git/refs`, { ref: 'refs/heads/task-8', sha: '' })
    const c1 = await fetch(`${at}/repos/${REPO}/contents/tasks/first.md`, {
      method: 'PUT',
      headers: HEADERS,
      body: JSON.stringify({
        message: 'Add the first file',
        content: Buffer.from('# first\n').toString('base64'),
        branch: 'task-8',
      }),
    })
    const shaC1 = String(field(field((await c1.json()) as JsonValue, 'commit'), 'sha') ?? '')
    check('a contents write records a commit', shaC1 !== '', shaC1)
    const selfMove = await fetch(`${at}/repos/${REPO}/git/refs/heads/task-8`, {
      method: 'PATCH',
      headers: HEADERS,
      body: JSON.stringify({ sha: shaC1 }),
    })
    check(
      'a ref can be moved onto a contents commit',
      selfMove.status === 200,
      String(selfMove.status),
    )

    // ---- and that commit is a SNAPSHOT: a branch created at it carries the
    // files it recorded, not whatever the branch it came from holds now.
    const c2 = await fetch(`${at}/repos/${REPO}/contents/tasks/second.md`, {
      method: 'PUT',
      headers: HEADERS,
      body: JSON.stringify({
        message: 'Add the second file',
        content: Buffer.from('# second\n').toString('base64'),
        branch: 'task-8',
      }),
    })
    check('the branch advances past it', c2.status === 201, String(c2.status))
    const snap = await post(`${at}/repos/${REPO}/git/refs`, {
      ref: 'refs/heads/task-8-snap',
      sha: shaC1,
    })
    check('a ref can be created at the older one', snap.status === 201, String(snap.status))
    eq('and reports it', field(field(snap.body, 'object'), 'sha'), shaC1)
    const kept = await fetch(`${at}/repos/${REPO}/contents/tasks/first.md?ref=task-8-snap`, {
      headers: HEADERS,
    })
    check(
      'the snapshot carries what that commit recorded',
      kept.status === 200,
      String(kept.status),
    )
    const later = await fetch(`${at}/repos/${REPO}/contents/tasks/second.md?ref=task-8-snap`, {
      headers: HEADERS,
    })
    check('and not what the branch gained afterwards', later.status === 404, String(later.status))

    // REST and GraphQL return comments oldest first.
    const opened = await post(`${at}/repos/${REPO}/issues`, {
      title: 'License info. needed',
      body: 'Could you provide license info.?',
    })
    check('an issue is opened', opened.status === 201, String(opened.status))
    const issueNo = String(field(opened.body, 'number') ?? '')
    const empty = await get(`${at}/repos/${REPO}/issues/${issueNo}/comments`)
    eq('a fresh issue lists no comments', empty, [])
    for (const body of ['first', 'second']) {
      const said = await post(`${at}/repos/${REPO}/issues/${issueNo}/comments`, { body })
      check(`a comment is posted (${body})`, said.status === 201, String(said.status))
    }
    const thread = await get(`${at}/repos/${REPO}/issues/${issueNo}/comments`)
    const bodies = Array.isArray(thread) ? thread.map((c) => field(c, 'body')) : []
    eq('and both come back oldest first', bodies, ['first', 'second'])
    check(
      'each carries the author a grader checks',
      Array.isArray(thread) && thread.every((c) => field(field(c, 'user'), 'login') !== null),
      JSON.stringify(thread).slice(0, 200),
    )
    const noSuch = await fetch(`${at}/repos/${REPO}/issues/4242/comments`, { headers: HEADERS })
    check('an issue that is not there is 404', noSuch.status === 404, String(noSuch.status))

    // ---- `user:` and `org:` NARROW, which is the only reason to ask with one.
    // A caller scoped to one account and handed every account's repositories
    // cannot tell from the answer that it was not scoped at all.
    const OTHER = 'integ-archive'
    const born = await post(`${at}/orgs/${OTHER}/repos`, { name: 'repo-archived' })
    check('a repo is created under a second owner', born.status === 201, String(born.status))

    const found = async (q: string): Promise<JsonValue[]> => {
      const body = await get(`${at}/search/repositories?q=${encodeURIComponent(q)}`)
      const items = field(body, 'items')
      return Array.isArray(items) ? items.map((r) => field(r, 'full_name')).sort() : []
    }

    eq('`user:` lists that account and no other', await found('user:integ'), [
      'integ/data-v1',
      'integ/repo-cli',
      'integ/repo-trunc',
      'integ/repo-v1',
    ])
    eq('`org:` scopes the same way', await found(`org:${OTHER}`), [`${OTHER}/repo-archived`])
    eq('an account holding nothing is empty, not everything', await found('user:nobody'), [])
    eq('two of them OR together', await found(`user:nobody org:${OTHER}`), [
      `${OTHER}/repo-archived`,
    ])
    // The scope ANDs with the terms: `repo` matches all four rows by name, and
    // the owner is what keeps the fourth out.
    eq('a term widens only within the scope', await found('user:integ repo'), [
      'integ/repo-cli',
      'integ/repo-trunc',
      'integ/repo-v1',
    ])
    // Unscoped, that same term reaches every owner -- the looseness the fake
    // keeps on purpose, so that a caller hunting a row is shown it.
    eq('and reaches every owner when nothing scopes it', await found('repo'), [
      `${OTHER}/repo-archived`,
      'integ/repo-cli',
      'integ/repo-trunc',
      'integ/repo-v1',
    ])

    // ---- code search answers a query that names no repository, over every
    // repository the tenant holds, because an authenticated caller of the live
    // API is answered over all of GitHub rather than refused. The scope rules
    // below were measured against api.github.com on 2026-09-24. This block sits
    // after `found('repo')`, which `Repo-Mixed` would otherwise join, and before
    // the reset that reseeds.
    const codeSearch = async (
      q: string | null,
      prefix = '',
    ): Promise<{ status: number; body: JsonValue; items: string[] }> => {
      const query = q === null ? '' : `?q=${encodeURIComponent(q)}`
      const r = await fetch(`${at}${prefix}/search/code${query}`, { headers: HEADERS })
      const body = (await r.json()) as JsonValue
      const rows = field(body, 'items')
      // Keyed by the item's own `repository`, so an item filed under the wrong
      // repository reads as a different hit.
      const items = Array.isArray(rows)
        ? rows.map(
            (i) =>
              `${String(field(field(i, 'repository'), 'full_name'))}/${String(field(i, 'path'))}`,
          )
        : []
      return { status: r.status, body, items }
    }
    const hits = async (q: string): Promise<JsonValue> => {
      const r = await codeSearch(q)
      return r.status === 200 ? r.items : `HTTP ${String(r.status)}`
    }
    const MARK = 'quokkaseed'

    eq(
      'an unscoped query is answered, not refused',
      await codeSearch(MARK).then((r) => [r.status, r.body]),
      [200, { total_count: 0, incomplete_results: false, items: [] }],
    )

    const mixed = await post(`${at}/orgs/${OTHER}/repos`, { name: 'Repo-Mixed' })
    check('a mixed-case repo is created', mixed.status === 201, String(mixed.status))
    const CASED_OWNER = 'Integ-Case'
    const cased = await post(`${at}/orgs/${CASED_OWNER}/repos`, { name: 'zz-repo' })
    check('a repo is created under a mixed-case owner', cased.status === 201, String(cased.status))
    const write = async (repo: string, path: string, text: string): Promise<JsonValue> => {
      const r = await fetch(`${at}/repos/${repo}/contents/${path}`, {
        method: 'PUT',
        headers: HEADERS,
        body: JSON.stringify({
          message: `add ${path}`,
          content: Buffer.from(text).toString('base64'),
        }),
      })
      check(`a file is written to ${repo}`, r.status === 201, String(r.status))
      return field(field((await r.json()) as JsonValue, 'content'), 'sha')
    }
    // Three owners, one of them mixed-case, a mixed-case name, and `alpha` in
    // only two files. The repositories created last sort first by full name,
    // and `Integ-Case/zz-repo` sorts first by full name but last by name, so
    // creation order, name order and full-name order all read differently.
    await write(`${CASED_OWNER}/zz-repo`, 'docs/cased.md', `${MARK}\n`)
    const mixedSha = await write(`${OTHER}/Repo-Mixed`, 'notes/mixed.md', `${MARK}\n`)
    await write(`${OTHER}/repo-archived`, 'notes/shared.md', `${MARK} alpha\n`)
    await write('integ/repo-cli', 'notes/shared.md', `${MARK} alpha\n`)
    await write('integ/repo-v1', 'docs/shared.md', `${MARK}\n`)
    const MIXED = `${OTHER}/Repo-Mixed/notes/mixed.md`
    const ARCHIVED = `${OTHER}/repo-archived/notes/shared.md`
    const CLI = 'integ/repo-cli/notes/shared.md'
    const V1 = 'integ/repo-v1/docs/shared.md'
    const CASED = `${CASED_OWNER}/zz-repo/docs/cased.md`
    const ALL = [CASED, MIXED, ARCHIVED, CLI, V1]

    const everything = await codeSearch(MARK)
    eq('unscoped, every repository is searched, in full-name order', everything.items, ALL)
    eq('and the count is every hit', field(everything.body, 'total_count'), 5)
    const hitRows = field(everything.body, 'items')
    const repoOf = (row: JsonValue | undefined): JsonValue => {
      const repo = field(row ?? null, 'repository')
      return { name: field(repo, 'name'), full_name: field(repo, 'full_name') }
    }
    eq(
      'each hit names its own repository (first)',
      repoOf(Array.isArray(hitRows) ? hitRows[0] : undefined),
      {
        name: 'zz-repo',
        full_name: `${CASED_OWNER}/zz-repo`,
      },
    )
    eq(
      'each hit names its own repository (last)',
      repoOf(Array.isArray(hitRows) ? hitRows.at(-1) : undefined),
      {
        name: 'repo-v1',
        full_name: 'integ/repo-v1',
      },
    )
    for (const prefix of ['', '/api/v3']) {
      const r = await codeSearch('"Mixture-of-Depths"', prefix)
      eq(
        `a query matching nothing is a 200 with nothing (${prefix || '/'})`,
        [r.status, r.body],
        [200, { total_count: 0, incomplete_results: false, items: [] }],
      )
    }

    // `user:` and `org:` narrow and OR together; an owner compares
    // case-insensitively on both sides, as `searchRepos` does.
    eq('`user:` narrows code search to that owner', await hits(`user:integ ${MARK}`), [CLI, V1])
    eq('`org:` narrows the same way', await hits(`org:${OTHER} ${MARK}`), [MIXED, ARCHIVED])
    eq('an owner value compares case-insensitively', await hits(`user:INTEG-Archive ${MARK}`), [
      MIXED,
      ARCHIVED,
    ])
    eq('and so does the owner it is compared with', await hits(`org:integ-case ${MARK}`), [CASED])
    eq('an owner holding nothing is empty, not everything', await hits(`user:nobody ${MARK}`), [])
    eq('two owners OR together', await hits(`user:nobody org:${OTHER} ${MARK}`), [MIXED, ARCHIVED])

    // Several `repo:` OR together; with an owner as well, the two groups AND.
    eq(
      'several `repo:` OR together',
      await hits(`repo:integ/repo-cli repo:${OTHER}/repo-archived ${MARK}`),
      [ARCHIVED, CLI],
    )
    const twice = await codeSearch(`repo:integ/repo-cli repo:integ/repo-cli ${MARK}`)
    eq(
      'a repo named twice is searched once',
      [twice.items, field(twice.body, 'total_count')],
      [[CLI], 1],
    )
    eq('`repo:` and `user:` intersect', await hits(`repo:integ/repo-cli user:integ ${MARK}`), [CLI])
    eq(
      '`repo:` and `org:` intersect',
      await hits(`repo:integ/repo-cli repo:${OTHER}/repo-archived org:integ ${MARK}`),
      [CLI],
    )
    // Live refuses a disjoint intersection with a query-parse 422; an empty
    // answer is the looser equivalent and carries no engine artefact.
    eq(
      'a disjoint intersection is empty',
      await hits(`repo:integ/repo-cli user:${OTHER} ${MARK}`),
      [],
    )
    eq(
      'a missing repo among several is skipped',
      await hits(`repo:integ/repo-cli repo:integ/no-such ${MARK}`),
      [CLI],
    )
    eq('a query naming only a missing repo is empty', await hits(`repo:integ/no-such ${MARK}`), [])
    eq(
      'an owner does not widen a missing repository',
      await hits(`repo:integ/no-such user:integ ${MARK}`),
      [],
    )
    eq('a `repo:` value is taken verbatim', await hits(`repo:${OTHER}/Repo-Mixed ${MARK}`), [MIXED])

    // Qualifier names are exact and case-sensitive, as live reads them;
    // anything else is a term, split by the tokenizer.
    eq('a word holding `::` stays terms', await hits(`${MARK}::alpha`), [ARCHIVED, CLI])
    eq(
      'an uppercase qualifier name is a term',
      await hits(`repo:integ/repo-v1 REPO:integ/repo-cli ${MARK}`),
      [],
    )
    eq('a negated qualifier is a term', await hits(`-repo:integ/repo-cli ${MARK}`), [])
    // A file's name, extension, language and size narrow, as GitHub's code
    // search syntax defines them; where a term matches and forks are dropped
    // rather than matched as words, which only ever widens.
    const fileFilters: Array<[string, string, JsonValue[]]> = [
      ['`filename:` keeps that name', 'filename:shared.md', [CLI]],
      ['and nothing else', 'filename:nothing.txt', []],
      ['`extension:` keeps that extension', 'extension:md', [CLI]],
      ['with or without its dot', 'extension:.md', [CLI]],
      ['and nothing else', 'extension:py', []],
      ["`language:` keeps Linguist's name for the file", 'language:Markdown', [CLI]],
      ['in any case', 'language:markdown', [CLI]],
      ['and nothing else', 'language:Haskell', []],
      ['`size:` compares the bytes', 'size:>0', [CLI]],
      ['and narrows', 'size:<1', []],
    ]
    for (const [name, qualifier, want] of fileFilters) {
      eq(name, await hits(`repo:integ/repo-cli ${qualifier} ${MARK}`), want)
    }
    for (const name of ['in', 'fork']) {
      eq(`\`${name}:\` is dropped`, await hits(`repo:integ/repo-cli ${name}:x ${MARK}`), [CLI])
    }
    eq('and dropping one does not scope', await hits(`in:x ${MARK}`), ALL)
    // Live refuses an empty qualifier value with a query-parse 422.
    eq('an empty `user:` is dropped', await hits(`user: ${MARK}`), ALL)
    eq('an empty `repo:` is dropped', await hits(`repo: ${MARK}`), ALL)
    // Live lists every file in scope; the fake matches files by terms only.
    eq('a query of only a scope is empty', await hits('user:integ'), [])
    eq('a query of only a dropped filter is empty', await hits('language:python'), [])

    eq('`path:` narrows each repository', await hits(`path:notes ${MARK}`), [MIXED, ARCHIVED, CLI])
    eq('a term compares case-insensitively', await hits(`repo:integ/repo-cli QuokkaSeed`), [CLI])
    eq(
      'a `path:` value is taken verbatim',
      await hits(`repo:integ/repo-cli path:Notes ${MARK}`),
      [],
    )
    const one = await codeSearch(`repo:${OTHER}/Repo-Mixed ${MARK}`)
    const blobs = field(one.body, 'items')
    eq(
      'a hit carries the blob it names',
      Array.isArray(blobs)
        ? blobs.map((row) => ({
            name: field(row, 'name'),
            path: field(row, 'path'),
            sha: field(row, 'sha'),
            score: field(row, 'score'),
            repository: repoOf(row),
          }))
        : blobs,
      [
        {
          name: 'mixed.md',
          path: 'notes/mixed.md',
          sha: mixedSha,
          score: 1,
          repository: { name: 'Repo-Mixed', full_name: `${OTHER}/Repo-Mixed` },
        },
      ],
    )
    for (const prefix of ['', '/api/v3']) {
      for (const q of ['', '  ', null]) {
        const r = await codeSearch(q, prefix)
        eq(
          `an empty query is refused (${JSON.stringify(q)}, ${prefix || '/'})`,
          [r.status, field(r.body, 'message')],
          [422, 'Validation Failed'],
        )
      }
    }

    const commentsReset = await fetch(`${at}/reset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tenants: [TENANT], fixture: 'comments' }),
    })
    check('comment metadata fixture is seeded', commentsReset.status === 200)
    const query = `query($cursor: String) {
      repository(owner: "integ", name: "repo-comments") {
        issueOrPullRequest(number: 1) { ... on Issue {
          comments(first: 1, after: $cursor) {
            nodes { body author { login } authorAssociation includesCreatedEdit
              isMinimized minimizedReason viewerDidAuthor reactionGroups { content users { totalCount } } }
            pageInfo { hasNextPage endCursor }
          }
        } }
      }
    }`
    const graph = async (cursor: JsonValue): Promise<JsonValue> => {
      const response = await post(`${at}/graphql`, { query, variables: { cursor } })
      eq('GraphQL response has no errors', field(response.body, 'errors'), null)
      return field(
        field(field(field(response.body, 'data'), 'repository'), 'issueOrPullRequest'),
        'comments',
      )
    }
    const firstPage = await graph(null)
    const nodes = field(firstPage, 'nodes') as JsonValue[]
    eq('first GraphQL page respects its limit', nodes.length, 1)
    eq('GraphQL preserves nullable author and comment metadata', nodes[0] ?? null, {
      body: 'comment 1',
      author: null,
      authorAssociation: 'CONTRIBUTOR',
      includesCreatedEdit: true,
      isMinimized: true,
      minimizedReason: 'OUTDATED',
      viewerDidAuthor: false,
      reactionGroups: [
        { content: 'THUMBS_UP', users: { totalCount: 2 } },
        { content: 'LAUGH', users: { totalCount: 0 } },
      ],
    })
    eq('first page has a continuation', field(field(firstPage, 'pageInfo'), 'hasNextPage'), true)
    const lastPage = await graph(field(field(firstPage, 'pageInfo'), 'endCursor'))
    eq(
      'cursor advances to the last comment',
      (field(lastPage, 'nodes') as JsonValue[]).map((row) => field(row, 'body')),
      ['comment 2'],
    )
    eq('last page terminates pagination', field(field(lastPage, 'pageInfo'), 'hasNextPage'), false)

    // ---- GraphQL repository lists honour orderBy and filters, and a fork's
    // parent is found by identity, so renaming the source keeps it
    const v1Seed = await fetch(`${at}/reset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tenants: [TENANT], fixture: 'v1' }),
    })
    check('the v1 fixture is seeded again', v1Seed.status === 200)
    const repositoryNames = async (login: string, args: string): Promise<JsonValue[]> => {
      const r = await post(`${at}/graphql`, {
        query: `{ repositoryOwner(login: "${login}") { repositories(first: 10${args}) { nodes { name } } } }`,
      })
      eq(`repositories(${args}) has no errors`, field(r.body, 'errors'), null)
      const page = field(field(field(r.body, 'data'), 'repositoryOwner'), 'repositories')
      return (field(page, 'nodes') as JsonValue[]).map((node) => field(node, 'name'))
    }
    eq(
      'repositories order by name ascending',
      await repositoryNames('integ', ', orderBy: { field: NAME, direction: ASC }'),
      ['data-v1', 'repo-cli', 'repo-trunc', 'repo-v1'],
    )
    eq(
      'repositories order by name descending',
      await repositoryNames('integ', ', orderBy: { field: NAME, direction: DESC }'),
      ['repo-v1', 'repo-trunc', 'repo-cli', 'data-v1'],
    )
    eq(
      'repositories a push order ties are listed by name',
      await repositoryNames('integ', ', orderBy: { field: PUSHED_AT, direction: DESC }'),
      ['data-v1', 'repo-cli', 'repo-trunc', 'repo-v1'],
    )
    const forked = await post(`${at}/repos/integ/repo-v1/forks`, { name: 'v1-fork' })
    check('the fork is created', forked.status < 300, String(forked.status))
    const renamed = await fetch(`${at}/repos/integ/repo-v1`, {
      method: 'PATCH',
      headers: HEADERS,
      body: JSON.stringify({ name: 'repo-v1-moved' }),
    })
    check('the source is renamed', renamed.status === 200, String(renamed.status))
    const parent = await post(`${at}/graphql`, {
      query:
        '{ repository(owner: "integ-user", name: "v1-fork") { isFork parent { name owner { login } } } }',
    })
    eq('a fork names its parent under the name it carries now', field(parent.body, 'data'), {
      repository: { isFork: true, parent: { name: 'repo-v1-moved', owner: { login: 'integ' } } },
    })
    eq(
      'isFork narrows a repository list to forks',
      await repositoryNames('integ-user', ', isFork: true'),
      ['v1-fork'],
    )
    eq(
      'isFork: false leaves the forks out',
      await repositoryNames('integ-user', ', isFork: false'),
      [],
    )

    // ---- a pull request over GraphQL: every field gh pr view/list read, its
    // reviews and review requests, the issue its body closes, and the checks
    // rolled up on its head commit, a page at a time
    const cliSeed = await fetch(`${at}/reset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tenants: [TENANT], fixture: 'cli' }),
    })
    check('the cli fixture is seeded', cliSeed.status === 200)
    const repoCli = `${at}/repos/integ/repo-cli`
    const tracked = await post(`${repoCli}/issues`, { title: 'tracked' })
    eq('an issue for the pull request to close', field(tracked.body, 'number'), 1)
    const cliMain = field(field(await get(`${repoCli}/git/ref/heads/main`), 'object'), 'sha')
    const cut = await post(`${repoCli}/git/refs`, { ref: 'refs/heads/docs', sha: cliMain })
    eq('a docs branch is cut from main', cut.status, 201)
    const unchanged = await post(`${repoCli}/pulls`, { title: 'docs', head: 'docs', base: 'main' })
    eq('a head with nothing past its base opens nothing', field(unchanged.body, 'errors'), [
      { resource: 'PullRequest', code: 'custom', message: 'No commits between main and docs' },
    ])
    const readme = await fetch(`${repoCli}/contents/README.md`, {
      method: 'PUT',
      headers: HEADERS,
      body: JSON.stringify({
        message: 'Point at the docs\n\nThe README says where they live.',
        content: Buffer.from(
          '# repo-v1\n\nFixture repository for the fake GitHub API server.\nSee docs/.\n',
        ).toString('base64'),
        sha: field(await get(`${repoCli}/contents/README.md?ref=docs`), 'sha'),
        branch: 'docs',
      }),
    })
    eq('the docs branch changes the README', readme.status, 200)
    const missingHead = await post(`${repoCli}/pulls`, { title: 'x', head: 'nope', base: 'main' })
    eq(
      'a head that is no branch opens nothing',
      [missingHead.status, field(missingHead.body, 'errors')],
      [422, [{ resource: 'PullRequest', field: 'head', code: 'invalid' }]],
    )
    const docsPull = await post(`${repoCli}/pulls`, {
      title: 'docs',
      head: 'docs',
      base: 'main',
      body: 'Fixes #1',
    })
    eq('the pull request is opened', field(docsPull.body, 'number'), 2)
    const approve = await post(`${repoCli}/pulls/2/reviews`, { event: 'APPROVE' })
    eq(
      'an author may not approve their own pull request',
      [approve.status, field(approve.body, 'errors')],
      [422, ['Can not approve your own pull request']],
    )
    const bareReview = await post(`${repoCli}/pulls/2/reviews`, { event: 'COMMENT' })
    eq('a comment review needs a body', bareReview.status, 422)
    const review = await post(`${repoCli}/pulls/2/reviews`, { event: 'COMMENT', body: 'lgtm' })
    eq(
      'a comment review is recorded as COMMENTED',
      [review.status, field(review.body, 'state'), field(review.body, 'body')],
      [200, 'COMMENTED', 'lgtm'],
    )
    const own = await post(`${repoCli}/pulls/2/requested_reviewers`, { reviewers: ['integ-user'] })
    eq(
      'a review cannot be requested of the author',
      [own.status, field(own.body, 'message')],
      [422, 'Review cannot be requested from pull request author.'],
    )
    const asked = await post(`${repoCli}/pulls/2/requested_reviewers`, {
      reviewers: ['octo-reviewer'],
    })
    eq('a review is requested of someone else', asked.status, 201)
    const pullGraph = async (selection: string): Promise<JsonValue> => {
      const r = await post(`${at}/graphql`, {
        query: `{ repository(owner: "integ", name: "repo-cli") { ${selection} } }`,
      })
      return r.body
    }
    const pr = await pullGraph(
      'pullRequest(number: 2) { state closed number files(first: 100) { nodes { path additions ' +
        'deletions } } reviews(first: 100) { nodes { state body author { login } } } ' +
        'latestReviews(first: 100) { nodes { state } } reviewRequests(first: 100) { nodes { ' +
        'requestedReviewer { __typename ... on User { login } } } } closingIssuesReferences(' +
        'first: 100) { nodes { number } } author { login ... on User { name } } ' +
        'headRepositoryOwner { login ... on User { name } } mergedBy { login } }',
    )
    eq('a pull request answers every field it is asked for', field(pr, 'data'), {
      repository: {
        pullRequest: {
          state: 'OPEN',
          closed: false,
          number: 2,
          files: { nodes: [{ path: 'README.md', additions: 1, deletions: 0 }] },
          reviews: {
            nodes: [{ state: 'COMMENTED', body: 'lgtm', author: { login: 'integ-user' } }],
          },
          latestReviews: { nodes: [] },
          reviewRequests: {
            nodes: [{ requestedReviewer: { __typename: 'User', login: 'octo-reviewer' } }],
          },
          closingIssuesReferences: { nodes: [{ number: 1 }] },
          author: { login: 'integ-user', name: 'integ-user' },
          headRepositoryOwner: { login: 'integ' },
          mergedBy: null,
        },
      },
    })
    const issueAsPull = await pullGraph('pullRequest(number: 1) { number }')
    eq(
      'an issue number is no pull request',
      (field(issueAsPull, 'errors') as JsonValue[]).map((e) => [
        field(e, 'message'),
        field(e, 'path'),
      ]),
      [['Could not resolve to a PullRequest with the number of 1.', ['repository', 'pullRequest']]],
    )
    const pullLists = await pullGraph(
      'open: pullRequests(states: [OPEN], first: 10) { totalCount nodes { number } } ' +
        'merged: pullRequests(states: MERGED, first: 10) { totalCount }',
    )
    eq('pullRequests narrows by state', field(pullLists, 'data'), {
      repository: { open: { totalCount: 1, nodes: [{ number: 2 }] }, merged: { totalCount: 0 } },
    })
    const owned = await post(`${at}/graphql`, {
      query:
        '{ repositoryOwner(login: "integ") { repositories(first: 100) { nodes { name ' +
        'pullRequests(states: [OPEN], first: 10) { nodes { number repository { name } } } ' +
        'issues(first: 1) { pageInfo { hasNextPage } } } } } }',
    })
    const cli = (
      field(
        field(field(field(owned.body, 'data'), 'repositoryOwner'), 'repositories'),
        'nodes',
      ) as JsonValue[]
    ).find((repo) => field(repo, 'name') === 'repo-cli')
    eq(
      'a repository reached through its owner answers its connections as a top-level one does',
      [field(owned.body, 'errors'), field(cli ?? null, 'pullRequests')],
      [null, { nodes: [{ number: 2, repository: { name: 'repo-cli' } }] }],
    )
    const cards = await pullGraph(
      'pullRequest(number: 2) { projectCards(first: 100) { totalCount } }',
    )
    eq(
      'project cards are refused as the vendor refuses Projects (classic)',
      (field(cards, 'errors') as JsonValue[]).map((e) => field(e, 'path')),
      [['repository', 'pullRequest', 'projectCards']],
    )
    // CI state belongs to the commit it was set on: the fixture's check runs
    // and status are on main's seeded commit, and the pull request's head,
    // a new commit, carries only what is set on it.
    const docsHead = String(field(field(docsPull.body, 'head'), 'sha'))
    const checksOn = async (ref: string): Promise<JsonValue> =>
      (
        (field(await get(`${repoCli}/commits/${ref}/check-runs`), 'check_runs') ??
          []) as JsonValue[]
      ).map((row) => [field(row, 'name'), field(row, 'conclusion'), field(row, 'head_sha')])
    eq(
      'the fixture states its check runs on the commit they ran on',
      await checksOn(String(cliMain)),
      [
        ['test', 'success', cliMain],
        ['flaky', 'cancelled', cliMain],
      ],
    )
    eq('a commit nobody ran checks on has none', await checksOn(docsHead), [])
    const combined = async (ref: string): Promise<JsonValue> => {
      const body = await get(`${repoCli}/commits/${ref}/status`)
      return [field(body, 'state'), field(body, 'total_count')]
    }
    eq('a commit with no statuses is pending with none', await combined(docsHead), ['pending', 0])
    for (const [context, state] of [
      ['lint', 'pending'],
      ['build', 'success'],
      ['lint', 'success'],
    ] as const) {
      const set = await post(`${repoCli}/statuses/${docsHead}`, { context, state })
      eq(`a ${state} ${context} status is set on the head`, set.status, 201)
    }
    eq('the newest of each context rolls up', await combined('docs'), ['success', 2])
    eq(
      'and every status stays listed',
      ((await get(`${repoCli}/commits/${docsHead}/statuses`)) as JsonValue[]).map((row) => [
        field(row, 'context'),
        field(row, 'state'),
      ]),
      [
        ['lint', 'success'],
        ['build', 'success'],
        ['lint', 'pending'],
      ],
    )
    eq("the fixture's status stays on its own commit", await combined(String(cliMain)), [
      'success',
      1,
    ])
    eq(
      'a status on nothing is refused',
      (await post(`${repoCli}/statuses/${'0'.repeat(40)}`, { state: 'success' })).status,
      422,
    )
    eq(
      "a check run is an app's to create",
      [
        (await post(`${repoCli}/check-runs`, { name: 'x', head_sha: docsHead })).status,
        field(
          (await post(`${repoCli}/check-runs`, { name: 'x', head_sha: docsHead })).body,
          'message',
        ),
      ],
      [403, 'You must authenticate via a GitHub App.'],
    )
    await post(`${repoCli}/statuses/${docsHead}`, { context: 'docs', state: 'success' })
    const contexts = async (after: string): Promise<JsonValue> =>
      field(
        field(
          (
            field(
              field(
                field(
                  field(
                    await pullGraph(
                      'pullRequest(number: 2) { commits(last: 1) { nodes { commit { ' +
                        `statusCheckRollup { contexts(first: 2${after}) { nodes { __typename } ` +
                        'pageInfo { hasNextPage endCursor } } } } } } }',
                    ),
                    'data',
                  ),
                  'repository',
                ),
                'pullRequest',
              ),
              'commits',
            ) as { nodes: JsonValue[] }
          ).nodes[0] ?? null,
          'commit',
        ),
        'statusCheckRollup',
      )
    const firstChecks = field(await contexts(''), 'contexts')
    eq(
      "the head commit's rollup pages its statuses",
      [
        (field(firstChecks, 'nodes') as JsonValue[]).map((node) => field(node, '__typename')),
        field(field(firstChecks, 'pageInfo'), 'hasNextPage'),
      ],
      [['StatusContext', 'StatusContext'], true],
    )
    const cursor = field(field(firstChecks, 'pageInfo'), 'endCursor') as string
    const lastChecks = field(await contexts(`, after: "${cursor}"`), 'contexts')
    eq(
      'and the next page is the rest',
      [
        (field(lastChecks, 'nodes') as JsonValue[]).map((node) => field(node, '__typename')),
        field(field(lastChecks, 'pageInfo'), 'hasNextPage'),
      ],
      [['StatusContext'], false],
    )
    const tracked1 = await pullGraph(
      'issue(number: 1) { state stateReason closed closedAt closedByPullRequestsReferences(' +
        'first: 100) { nodes { number } } }',
    )
    eq('an issue names the pull request that closes it', field(tracked1, 'data'), {
      repository: {
        issue: {
          state: 'OPEN',
          stateReason: null,
          closed: false,
          closedAt: null,
          closedByPullRequestsReferences: { nodes: [{ number: 2 }] },
        },
      },
    })
    const reason = async (state: string): Promise<JsonValue> => {
      const r = await fetch(`${repoCli}/issues/1`, {
        method: 'PATCH',
        headers: HEADERS,
        body: JSON.stringify({ state }),
      })
      check(`the issue is set ${state}`, r.status === 200, String(r.status))
      const graph = await pullGraph('issue(number: 1) { state stateReason closedAt }')
      return field(field(field(graph, 'data'), 'repository'), 'issue')
    }
    eq('closing records why and when', await reason('closed'), {
      state: 'CLOSED',
      stateReason: 'COMPLETED',
      closedAt: '2026-01-01T00:02:00Z',
    })
    eq('reopening records that it was reopened', await reason('open'), {
      state: 'OPEN',
      stateReason: 'REOPENED',
      closedAt: null,
    })
    const either = await pullGraph(
      'a: issueOrPullRequest(number: 1) { __typename } ' +
        'b: issueOrPullRequest(number: 2) { __typename ... on PullRequest { headRefName } }',
    )
    eq('issueOrPullRequest answers an issue or a pull request', field(either, 'data'), {
      repository: {
        a: { __typename: 'Issue' },
        b: { __typename: 'PullRequest', headRefName: 'docs' },
      },
    })
    const neither = await pullGraph('issueOrPullRequest(number: 99) { __typename }')
    eq(
      'a number that is neither is refused',
      (field(neither, 'errors') as JsonValue[]).map((e) => field(e, 'message')),
      ['Could not resolve to an issue or pull request with the number of 99.'],
    )
    const narrowed = await pullGraph(
      'all: issues(states: [OPEN, CLOSED], first: 10) { totalCount nodes { number } } ' +
        'labelled: issues(first: 10, filterBy: { labels: ["nope"] }) { totalCount }',
    )
    eq('issues narrows by labels', field(narrowed, 'data'), {
      repository: { all: { totalCount: 1, nodes: [{ number: 1 }] }, labelled: { totalCount: 0 } },
    })
    process.stdout.write(`github selftest: ${String(checks)} checks passed\n`)
  } finally {
    fake.child.kill('SIGTERM')
  }
}

await main()
await metadataRepository()
