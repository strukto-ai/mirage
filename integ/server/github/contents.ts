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

import type { JsonValue, KitRoute, Reply } from '../kit/typescript/index.ts'
import { API_PREFIXES } from './config.ts'
import type { C } from './config.ts'
import { commitChanges } from './compare.ts'
import { changeJson } from './diff.ts'
import { rebuildOnPush } from './pages.ts'
import { blobSha, commitJson, commitSha, gitCommitJson, personJson } from './wire.ts'
import type { CommitRow, GitPerson } from './wire.ts'
import {
  blobBySha,
  branchFor,
  branchLinks,
  commitTreeId,
  directoriesOf,
  directoryIds,
  keepRoot,
  keepTree,
  repoIsEmpty,
  resolveRef,
  snapshotAt,
  snapshotOf,
  stageTree,
  treeById,
  treeIdOf,
  treeItems,
  treeOf,
  treeOfBranch,
  visibleHeadOf,
} from './store.ts'
import type { RepoRow, Snapshot } from './store.ts'
import {
  authedRoute,
  diffReply,
  everywhere,
  fail,
  jsonBodyOf,
  param,
  route,
  str,
  withRepo,
} from './http.ts'
import type { C as Client } from './config.ts'
import { stripSlash } from '../kit/typescript/index.ts'

function fileJson(path: string, data: Buffer): JsonValue {
  return {
    type: 'file',
    name: path.slice(path.lastIndexOf('/') + 1),
    path,
    sha: blobSha(data),
    size: data.length,
    encoding: 'base64',
    content: data.toString('base64'),
  }
}

// A directory listing, or null when the path is not a directory. A
// directory row carries the same tree id the git trees endpoint reports.
function dirJson(tree: Snapshot, at: string): JsonValue[] | null {
  const { files } = tree
  const prefix = at === '' ? '' : `${at}/`
  if (at !== '' && !directoriesOf(files).has(at)) return null
  const ids = directoryIds(files, tree.links)
  const entries = new Map<string, JsonValue>()
  for (const [candidate, data] of files) {
    if (!candidate.startsWith(prefix)) continue
    const rest = candidate.slice(prefix.length)
    const cut = rest.indexOf('/')
    const head = cut < 0 ? rest : rest.slice(0, cut)
    if (cut >= 0) {
      if (!entries.has(head)) {
        entries.set(head, {
          type: 'dir',
          name: head,
          path: `${prefix}${head}`,
          sha: ids.get(`${prefix}${head}`) ?? '',
          size: 0,
        })
      }
      continue
    }
    entries.set(head, {
      type: 'file',
      name: head,
      path: candidate,
      sha: blobSha(data),
      size: data.length,
    })
  }
  return [...entries.keys()].sort().map((k) => entries.get(k) as JsonValue)
}

async function nextCommitSeq(db: Client, tenant: string, repo: string): Promise<number> {
  const rows = await db.githubCommit.findMany({
    where: { tenant, repo },
    orderBy: { seq: 'desc' },
    take: 1,
  })
  const top = rows[0]
  return top === undefined ? 0 : top.seq + 1
}

// Record one commit. Its sha is content-addressed the way git's is: the
// parents, the tree, the people and the message decide it, and nothing about
// where it sits does. That is the whole reason a sha cannot be reproduced by a
// later commit landing in a freed slot, which is what a position-derived sha
// allowed every time a move or a reset released one. `seq` survives only as
// insertion order for a stable listing; no identity or history reads it.
//
// `advance` moves the branch's ref onto the new commit, which is what a
// /contents write does: the write IS the ref update, and a push, so a Pages
// site built from the branch builds again. A plumbing commit passes false and
// is born dangling, reachable by sha but on no branch until a ref update
// points at it. `parents` are in order, the first parent first; null takes
// the branch's head as the one parent, and an empty sha names none.
export async function recordCommit(
  db: Client,
  tenant: string,
  repo: RepoRow,
  message: string,
  branch: string,
  tree = '',
  people: { author: GitPerson | null; committer: GitPerson | null } = {
    author: null,
    committer: null,
  },
  parents: readonly string[] | null = null,
  advance = true,
): Promise<CommitRow> {
  const seq = await nextCommitSeq(db, tenant, repo.fullName)
  const authorJson = personJson(people.author)
  const committerJson = personJson(people.committer)
  const named = (parents ?? [await visibleHeadOf(db, tenant, repo, branch)]).filter(
    (sha) => sha !== '',
  )
  // EVERY commit names a tree, so every commit is a snapshot that can be read
  // back on its own. A plumbing commit names the one its caller staged; a
  // /contents commit stages the tree its own write just produced, which is why
  // this reads the branch AFTER the write has landed. Without it a commit born
  // here recorded no tree at all, and the only way to see its files was to read
  // whatever its branch happened to hold later, which is a different answer the
  // moment the branch moves.
  //
  // The tree is in the sha for the same reason git puts it there: two writes of
  // different bytes under one message onto one parent are two commits, and
  // addressing them by message and parent alone made them one.
  const stored =
    tree === ''
      ? await stageTree(
          db,
          tenant,
          repo,
          await treeOfBranch(db, tenant, repo, branch),
          await branchLinks(db, tenant, repo, branch),
        )
      : tree
  const sha = commitSha(
    [repo.fullName, named.join(' '), stored, authorJson, committerJson, message].join('\0'),
  )
  const row = (await db.githubCommit.create({
    data: {
      tenant,
      repo: repo.fullName,
      sha,
      parentSha: named[0] ?? '',
      otherParentsJson: JSON.stringify(named.slice(1)),
      message,
      authorLogin: '',
      date: '',
      treeSha: stored,
      authorJson,
      committerJson,
      seq,
    },
  })) as CommitRow
  if (advance) {
    await db.githubBranch.updateMany({
      where: { tenant, repo: repo.fullName, name: branch },
      data: { headSha: sha },
    })
    await rebuildOnPush(db, tenant, repo.fullName, branch)
  }
  return row
}

export async function writeFile(
  db: Client,
  tenant: string,
  repo: RepoRow,
  branch: string,
  path: string,
  data: Buffer,
): Promise<void> {
  const existing = await db.githubFile.findFirst({
    where: { tenant, repo: repo.fullName, branch, path },
  })
  const bytes = new Uint8Array(data)
  if (existing === null) {
    const last = await db.githubFile.findFirst({
      where: { tenant, repo: repo.fullName, branch },
      orderBy: { seq: 'desc' },
    })
    await db.githubFile.create({
      data: {
        tenant,
        repo: repo.fullName,
        branch,
        path,
        data: bytes,
        seq: last === null ? 0 : last.seq + 1,
      },
    })
    return
  }
  await db.githubFile.update({ where: { pk: existing.pk }, data: { data: bytes } })
}

// An empty repository is answered before the ref is resolved, so every ref
// gets the same 404 there, including one that names nothing. Only once
// something has been committed is an unknown ref the ref's own fault, and the
// refusal names it the way the vendor's does. A branch nothing has been
// committed to is refused the same way: it names no commit, and reading it as
// an empty tree would pass off a ref that points nowhere as an empty
// directory.
const contents = withRepo(async (ctx, repo) => {
  if (await repoIsEmpty(ctx.db, ctx.tenant, repo)) return fail(404, 'This repository is empty.')
  const ref = ctx.query.get('ref') ?? ''
  const at = await resolveRef(ctx.db, ctx.tenant, repo, ref)
  const tree =
    at === null || at.history.length === 0 ? null : await snapshotAt(ctx.db, ctx.tenant, repo, at)
  if (tree === null) {
    return fail(404, `No commit found for the ref ${ref === '' ? repo.defaultBranch : ref}`)
  }
  const path = stripSlash(param(ctx, 'path'))
  const hit = tree.files.get(path)
  if (hit !== undefined) return { status: 200, body: fileJson(path, hit) }
  const listing = dirJson(tree, path)
  if (listing === null) return fail(404, 'Not Found')
  return { status: 200, body: listing }
})

// The bytes a base64 payload spells, or null when it spells none. GitHub
// accepts a wrapped payload, and wraps its own at 60 columns, so whitespace is
// stripped before validating rather than refused by it. `base64 file` wraps
// at 76, and rejecting that made the fake stricter than the service it stands
// in for.
export function base64Bytes(raw: string): Buffer | null {
  const packed = raw.split(/\s+/).join('')
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(packed) || packed.length % 4 !== 0) return null
  return Buffer.from(packed, 'base64')
}

// GitHub requires the current blob sha to replace an existing file and refuses
// one for a new file; both are enforced, because a task that reads before
// writing is doing so for this reason.
const putContents = withRepo(async (ctx, repo) => {
  const body = jsonBodyOf(ctx)
  const path = stripSlash(param(ctx, 'path'))
  const raw = body.content
  if (raw === undefined || raw === null) {
    return fail(422, 'Invalid request.\n\n"content" wasn\'t supplied.')
  }
  const data = base64Bytes(String(raw))
  if (data === null) return fail(422, 'Invalid request.\n\n"content" is invalid.')
  const branch = await branchFor(ctx.db, ctx.tenant, repo, str(body, 'branch'))
  if (branch === null) return fail(404, 'Branch not found')
  const files = await treeOfBranch(ctx.db, ctx.tenant, repo, branch)
  const existing = files.get(path)
  const given = body.sha
  if (existing !== undefined && given !== blobSha(existing)) {
    return fail(409, `${path} does not match`)
  }
  if (existing === undefined && typeof given === 'string' && given !== '') {
    return fail(422, 'Invalid request.\n\n"sha" wasn\'t supplied.')
  }
  const created = existing === undefined
  // Read before the write, because the parent is where the ref pointed when
  // this request arrived: a seeded branch's root, or none on an empty branch.
  // After the write the same question names a root the ref never reported.
  const parent = await visibleHeadOf(ctx.db, ctx.tenant, repo, branch)
  // Kept for a new path as well as a replaced one: the first write to a
  // seeded branch is what moves it off its synthesized root.
  await keepRoot(ctx.db, ctx.tenant, repo, branch)
  await keepTree(ctx.db, ctx.tenant, repo, branch)
  await writeFile(ctx.db, ctx.tenant, repo, branch, path, data)
  const message = str(body, 'message') === '' ? `Update ${path}` : str(body, 'message')
  const commit = await recordCommit(ctx.db, ctx.tenant, repo, message, branch, '', undefined, [
    parent,
  ])
  return {
    status: created ? 201 : 200,
    body: {
      content: fileJson(path, data),
      commit: gitCommitJson(repo.fullName, commit, commit.treeSha),
    },
  }
})

const deleteContents = withRepo(async (ctx, repo) => {
  const body = jsonBodyOf(ctx)
  const path = stripSlash(param(ctx, 'path'))
  const branch = await branchFor(ctx.db, ctx.tenant, repo, str(body, 'branch'))
  if (branch === null) return fail(404, 'Branch not found')
  const row = await ctx.db.githubFile.findFirst({
    where: { tenant: ctx.tenant, repo: repo.fullName, branch, path },
  })
  if (row === null) return fail(404, 'Not Found')
  // GitHub requires the current blob sha here exactly as it does for a
  // replace, so a delete racing another writer is refused rather than applied.
  if (str(body, 'sha') !== blobSha(Buffer.from(row.data))) {
    return fail(409, `${path} does not match`)
  }
  const parent = await visibleHeadOf(ctx.db, ctx.tenant, repo, branch)
  await keepRoot(ctx.db, ctx.tenant, repo, branch)
  await keepTree(ctx.db, ctx.tenant, repo, branch)
  await ctx.db.githubFile.delete({ where: { pk: row.pk } })
  const message = str(body, 'message') === '' ? `Delete ${path}` : str(body, 'message')
  const commit = await recordCommit(ctx.db, ctx.tenant, repo, message, branch, '', undefined, [
    parent,
  ])
  return {
    status: 200,
    body: { content: null, commit: gitCommitJson(repo.fullName, commit, commit.treeSha) },
  }
})

const readme = withRepo(async (ctx, repo) => {
  const files = await treeOf(ctx.db, ctx.tenant, repo, ctx.query.get('ref') ?? '')
  if (files === null) return fail(404, 'Not Found')
  // GitHub picks the first of several spellings; the fake checks the same ones.
  for (const name of ['README.md', 'README', 'README.rst', 'README.txt', 'readme.md']) {
    const hit = files.get(name)
    if (hit !== undefined) return { status: 200, body: fileJson(name, hit) }
  }
  return fail(404, 'Not Found')
})

// `/commits/{ref}` and `/git/commits/{sha}` are different endpoints: this one
// takes a branch name as well as a sha and reports the file list, which is what
// a caller asking "what changed" reads.
//
// Emptiness comes first here too, so every ref gets the 409 in an empty
// repository. Past that, a ref that names no commit is a 422 quoting the ref
// as it was asked, whether it looks like a sha or like a branch: the vendor
// says "SHA" either way. A branch names its head and a sha, full or
// abbreviated, its own commit.
const oneCommit = withRepo(async (ctx, repo) => {
  if (await repoIsEmpty(ctx.db, ctx.tenant, repo)) return fail(409, 'Git Repository is empty.')
  const ref = param(ctx, 'ref')
  const history = (await resolveRef(ctx.db, ctx.tenant, repo, ref))?.history ?? []
  const [hit, parent] = history
  if (hit === undefined) return fail(422, `No commit found for SHA: ${ref}`)
  const changes = await commitChanges(ctx.db, ctx.tenant, repo, history)
  const diff = diffReply(ctx, changes)
  if (diff !== null) return diff
  const additions = changes.reduce((n, c) => n + c.additions, 0)
  const deletions = changes.reduce((n, c) => n + c.deletions, 0)
  return {
    status: 200,
    body: {
      ...(commitJson(
        repo.fullName,
        hit,
        await commitTreeId(ctx.db, ctx.tenant, repo, hit),
      ) as Record<string, JsonValue>),
      stats: { total: additions + deletions, additions, deletions },
      files: changes.map((c) => changeJson(repo.fullName, c, parent?.sha ?? '', hit.sha)),
    },
  }
})

// One tree listing: the directory `at` of `files`, as its own rows, or with
// `recursive` every row beneath it, paths relative to it. GitHub recurses for
// any value of the parameter, 0 and false included. A truncated repository
// cuts a recursive listing to the directory's own rows, the way git drops deep
// paths past its entry cap; a one-level listing is never cut short, since the
// per-directory walk asks for one and reading the recursive answer's
// truncation onto it refused a listing GitHub would have served whole.
function treeListing(
  repo: RepoRow,
  tree: Snapshot,
  at: string,
  sha: string,
  recursive: boolean,
): Reply {
  const cut = !recursive || repo.truncated
  const items = treeItems(tree, at).filter((it) => !cut || !it.path.includes('/'))
  return { status: 200, body: { sha, tree: items, truncated: recursive && repo.truncated } }
}

// The tree a request names, as git reads a tree-ish: a ref (branch, tag or
// commit, any of them with an ancestry suffix), a tree id a commit or a
// listing reported, whole or one directory's, or `{rev}:{dir}`, one directory
// of a rev, whose `dir` may hold slashes, sent plain or encoded. The backend
// asks the last form for a file's parent, and a directory's id from a
// previous listing as the truncation fallback. A ref is resolved through
// `resolveRef`, which accepts a commit sha too, because a client that
// resolves a ref to a commit then asks for the tree by that sha: git accepts
// it, since a commit names its root tree.
//
// A ref's tree answers the commit it resolved to as its top-level sha, the way
// GitHub does (measured 2026-09-30), so a ref and `{ref}:` answer different
// shas: the commit, and its root tree.
//
// An empty repository is answered first, for every form of the request: the
// recursive and shallow tree of a ref and one directory of it all 409, measured
// against GitHub (2026-09-27), whatever the ref names.
const gitTree = withRepo(async (ctx, repo) => {
  if (await repoIsEmpty(ctx.db, ctx.tenant, repo)) return fail(409, 'Git Repository is empty.')
  const ref = param(ctx, 'ref')
  if (ref === '') return fail(404, 'Not Found')
  const recursive = ctx.query.has('recursive')
  // A branch name cannot hold a colon, so the first one splits the rev from
  // its directory. Measured against GitHub (2026-09-25): a missing directory
  // or ref is 404, and a path through a file is 422.
  const colon = ref.indexOf(':')
  if (colon >= 0) {
    const tree = await snapshotOf(ctx.db, ctx.tenant, repo, ref.slice(0, colon))
    if (tree === null) return fail(404, 'Not Found')
    const { files } = tree
    const at = ref.slice(colon + 1).replace(/^\/+|\/+$/g, '')
    const parts = at === '' ? [] : at.split('/')
    for (let depth = 1; depth <= parts.length; depth += 1) {
      if (files.has(parts.slice(0, depth).join('/'))) {
        return fail(422, 'Invalid object requested. SHA must identify a commit or a tree.')
      }
    }
    const sha = directoryIds(files, tree.links).get(at)
    if (sha === undefined) return fail(404, 'Not Found')
    return treeListing(repo, tree, at, sha, recursive)
  }
  const resolved = await resolveRef(ctx.db, ctx.tenant, repo, ref)
  const tree = resolved === null ? null : await snapshotAt(ctx.db, ctx.tenant, repo, resolved)
  if (tree !== null) {
    const head = resolved?.history[0]?.sha ?? treeIdOf(tree.files, tree.links)
    return treeListing(repo, tree, '', head, recursive)
  }
  const named = await treeById(ctx.db, ctx.tenant, repo, ref)
  if (named === null) return fail(404, 'Not Found')
  return treeListing(repo, named, named.at, ref, recursive)
})

// GitHub wraps a base64 payload rather than emitting one long line, and so
// does python's base64.encodebytes: 76 columns and a trailing newline. A
// decoder ignores the breaks, but a golden renders them.
function wrapped(data: Buffer): string {
  const raw = data.toString('base64')
  const lines: string[] = []
  for (let i = 0; i < raw.length; i += 76) lines.push(raw.slice(i, i + 76))
  return `${lines.join('\n')}\n`
}

export function contentRoutes(): KitRoute<C>[] {
  return everywhere<C>(API_PREFIXES, (p) => [
    // Both spellings of the repository root: GitHub serves `/contents` as well
    // as `/contents/`, and a caller listing the root picks either.
    route<C>('GET', `${p}/repos/:owner/:repo/contents`, authedRoute(contents)),
    route<C>('GET', `${p}/repos/:owner/:repo/contents/*path`, authedRoute(contents)),
    route<C>('PUT', `${p}/repos/:owner/:repo/contents/*path`, authedRoute(putContents), {
      write: true,
    }),
    route<C>('DELETE', `${p}/repos/:owner/:repo/contents/*path`, authedRoute(deleteContents), {
      write: true,
    }),
    route<C>('GET', `${p}/repos/:owner/:repo/readme`, authedRoute(readme)),
    route<C>('GET', `${p}/repos/:owner/:repo/commits/*ref`, authedRoute(oneCommit)),
    route<C>('GET', `${p}/repos/:owner/:repo/git/trees/*ref`, authedRoute(gitTree)),
    route<C>(
      'GET',
      `${p}/repos/:owner/:repo/git/blobs/:sha`,
      authedRoute(
        withRepo(async (ctx, repo) => {
          // Answered before the sha is looked at, as a tree is.
          if (await repoIsEmpty(ctx.db, ctx.tenant, repo)) {
            return fail(409, 'Git Repository is empty.')
          }
          const want = param(ctx, 'sha')
          const data = await blobBySha(ctx.db, ctx.tenant, repo, want)
          if (data === null) return fail(404, 'Not Found')
          return {
            status: 200,
            body: { sha: want, size: data.length, content: wrapped(data), encoding: 'base64' },
          }
        }),
      ),
    ),
  ])
}

export { fileJson, dirJson }
