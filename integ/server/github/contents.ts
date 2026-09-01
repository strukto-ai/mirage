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

import type { JsonValue, KitRoute } from '../kit/typescript/index.ts'
import { API_PREFIXES } from './config.ts'
import type { C } from './config.ts'
import {
  blobSha,
  commitFiles,
  commitJson,
  commitSha,
  pathsOf,
  personJson,
  treeSha,
  writtenCommitJson,
} from './wire.ts'
import type { GitPerson } from './wire.ts'
import {
  branchFor,
  branchNames,
  commitList,
  directoriesOf,
  stageTree,
  submodulesOf,
  treeItems,
  treeOf,
  treeOfBranch,
  visibleHeadOf,
} from './store.ts'
import type { RepoRow, Tree } from './store.ts'
import { authedRoute, everywhere, fail, jsonBodyOf, param, route, str, withRepo } from './http.ts'
import type { C as Client } from './config.ts'

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

// A directory listing, or null when the path is not a directory.
function dirJson(files: Tree, at: string): JsonValue[] | null {
  const prefix = at === '' ? '' : `${at}/`
  if (at !== '' && !directoriesOf(files).has(at)) return null
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
          sha: treeSha(`${prefix}${head}`),
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
// parent, the tree, the people and the message decide it, and nothing about
// where it sits does. That is the whole reason a sha cannot be reproduced by a
// later commit landing in a freed slot, which is what a position-derived sha
// allowed every time a move or a reset released one. `seq` survives only as
// insertion order for a stable listing; no identity or history reads it.
//
// `advance` moves the branch's ref onto the new commit, which is what a
// /contents write does: the write IS the ref update. A plumbing commit passes
// false and is born dangling, reachable by sha but on no branch until a ref
// update points at it.
export async function recordCommit(
  db: Client,
  tenant: string,
  repo: RepoRow,
  message: string,
  paths: string[],
  branch: string,
  tree = '',
  people: { author: GitPerson | null; committer: GitPerson | null } = {
    author: null,
    committer: null,
  },
  parent: string | null = null,
  advance = true,
): Promise<{ sha: string; message: string }> {
  const seq = await nextCommitSeq(db, tenant, repo.fullName)
  const authorJson = personJson(people.author)
  const committerJson = personJson(people.committer)
  const parentSha = parent ?? (await visibleHeadOf(db, tenant, repo, branch))
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
      ? await stageTree(db, tenant, repo, await treeOfBranch(db, tenant, repo, branch))
      : tree
  const sha = commitSha(
    [repo.fullName, parentSha, stored, authorJson, committerJson, message].join('\0'),
  )
  await db.githubCommit.create({
    data: {
      tenant,
      repo: repo.fullName,
      sha,
      parentSha,
      message,
      authorLogin: '',
      date: '',
      filesJson: JSON.stringify(paths),
      treeSha: stored,
      authorJson,
      committerJson,
      seq,
    },
  })
  if (advance) {
    await db.githubBranch.updateMany({
      where: { tenant, repo: repo.fullName, name: branch },
      data: { headSha: sha },
    })
  }
  return { sha, message }
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

const contents = withRepo(async (ctx, repo) => {
  const files = await treeOf(ctx.db, ctx.tenant, repo, ctx.query.get('ref') ?? '')
  if (files === null) return fail(404, 'No commit found for the ref')
  const path = param(ctx, 'path').replace(/^\/+|\/+$/g, '')
  const hit = files.get(path)
  if (hit !== undefined) return { status: 200, body: fileJson(path, hit) }
  const listing = dirJson(files, path)
  if (listing === null) return fail(404, 'Not Found')
  return { status: 200, body: listing }
})

// GitHub requires the current blob sha to replace an existing file and refuses
// one for a new file; both are enforced, because a task that reads before
// writing is doing so for this reason.
const putContents = withRepo(async (ctx, repo) => {
  const body = jsonBodyOf(ctx)
  const path = param(ctx, 'path').replace(/^\/+|\/+$/g, '')
  const raw = body.content
  if (raw === undefined || raw === null) {
    return fail(422, 'Invalid request.\n\n"content" wasn\'t supplied.')
  }
  // GitHub accepts a wrapped payload, and wraps its own at 60 columns, so
  // whitespace is stripped before validating rather than refused by it.
  // `base64 file` wraps at 76, and rejecting that made the fake stricter than
  // the service it stands in for.
  const packed = String(raw).split(/\s+/).join('')
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(packed) || packed.length % 4 !== 0) {
    return fail(422, 'Invalid request.\n\n"content" is invalid.')
  }
  const data = Buffer.from(packed, 'base64')
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
  await writeFile(ctx.db, ctx.tenant, repo, branch, path, data)
  const message = str(body, 'message') === '' ? `Update ${path}` : str(body, 'message')
  const commit = await recordCommit(ctx.db, ctx.tenant, repo, message, [path], branch)
  return {
    status: created ? 201 : 200,
    body: { content: fileJson(path, data), commit: writtenCommitJson(commit) },
  }
})

const deleteContents = withRepo(async (ctx, repo) => {
  const body = jsonBodyOf(ctx)
  const path = param(ctx, 'path').replace(/^\/+|\/+$/g, '')
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
  await ctx.db.githubFile.delete({ where: { pk: row.pk } })
  const message = str(body, 'message') === '' ? `Delete ${path}` : str(body, 'message')
  const commit = await recordCommit(ctx.db, ctx.tenant, repo, message, [path], branch)
  return { status: 200, body: { content: null, commit: writtenCommitJson(commit) } }
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
const oneCommit = withRepo(async (ctx, repo) => {
  const ref = param(ctx, 'ref')
  const branch = await branchFor(ctx.db, ctx.tenant, repo, ref)
  const history = await commitList(ctx.db, ctx.tenant, repo, branch ?? repo.defaultBranch)
  const rendered: Array<Record<string, JsonValue>> = history.map((entry) => ({
    ...(commitJson(entry) as Record<string, JsonValue>),
    files: commitFiles(pathsOf(entry)),
  }))
  const exact = rendered.find((entry) => entry.sha === ref)
  if (exact !== undefined) return { status: 200, body: exact }
  // Any spelling branchFor resolves (bare, HEAD, refs/heads/...) names the head.
  if (branch !== null) return { status: 200, body: rendered[0] ?? null }
  return fail(404, 'Not Found')
})

// The backend passes either a ref name (a recursive whole-tree fetch) or a tree
// sha from a previous listing (the truncation fallback). A ref is resolved
// through `branchFor`, which accepts a commit sha too, because a client that
// resolves a ref to a commit then asks for the tree by that sha: git accepts
// it, since a commit names its root tree.
const gitTree = withRepo(async (ctx, repo) => {
  const ref = param(ctx, 'ref')
  const subs = await submodulesOf(ctx.db, ctx.tenant, repo)
  const files = await treeOf(ctx.db, ctx.tenant, repo, ref)
  if (files === null) {
    // Not a ref, so it may be one directory's tree sha. A per-sha tree GET is
    // one level deep in git; only the ref-name request carries recursive=1.
    const whole = await treeOfBranch(ctx.db, ctx.tenant, repo, repo.defaultBranch)
    const at = [...directoriesOf(whole)].sort().find((d) => treeSha(d) === ref)
    if (at === undefined) return fail(404, 'Not Found')
    const shallow = treeItems(whole, subs, at).filter((it) => !it.path.includes('/'))
    return { status: 200, body: { sha: treeSha(at), tree: shallow, truncated: false } }
  }
  // A truncated recursive tree keeps only the top-level entries, the way git
  // drops deep paths past its entry cap.
  let items = treeItems(files, subs)
  if (repo.truncated) items = items.filter((it) => !it.path.includes('/'))
  return { status: 200, body: { sha: treeSha(''), tree: items, truncated: repo.truncated } }
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
    route<C>('GET', `${p}/repos/:owner/:repo/git/trees/:ref`, authedRoute(gitTree)),
    route<C>(
      'GET',
      `${p}/repos/:owner/:repo/git/blobs/:sha`,
      authedRoute(
        withRepo(async (ctx, repo) => {
          const want = param(ctx, 'sha')
          for (const branch of await branchNames(ctx.db, ctx.tenant, repo)) {
            const files = await treeOfBranch(ctx.db, ctx.tenant, repo, branch)
            for (const data of files.values()) {
              if (blobSha(data) !== want) continue
              return {
                status: 200,
                body: {
                  sha: want,
                  size: data.length,
                  content: wrapped(data),
                  encoding: 'base64',
                },
              }
            }
          }
          return fail(404, 'Not Found')
        }),
      ),
    ),
  ])
}

export { fileJson, dirJson }
