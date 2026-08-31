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

import type { Ctx, JsonValue, KitRoute } from '../kit/typescript/index.ts'
import { API_PREFIXES } from './config.ts'
import type { C } from './config.ts'
import { INVALID_PERSON, blobSha, bodyPerson, commitPeople, personJson, treeSha } from './wire.ts'
import { addBranch, branchFor, branchNames, commitList, treeOfBranch } from './store.ts'
import type { RepoRow, Tree } from './store.ts'
import { authedRoute, everywhere, fail, jsonBodyOf, param, route, str, withRepo } from './http.ts'
import { recordCommit, writeFile } from './contents.ts'

async function blobBySha(
  db: C,
  tenant: string,
  repo: RepoRow,
  sha: string,
): Promise<Buffer | null> {
  for (const branch of await branchNames(db, tenant, repo)) {
    const files = await treeOfBranch(db, tenant, repo, branch)
    for (const data of files.values()) if (blobSha(data) === sha) return data
  }
  return null
}

// Scoped to the repository, not just the tenant. A staged sha is unique per
// tenant, so a bare lookup accepted a tree staged in repository A while the
// caller was operating on repository B, and committing it copied A's files
// into B. The fake this replaces held `repo.trees` per repository, so a foreign
// sha was simply not found there.
async function stagedTree(db: C, tenant: string, repo: RepoRow, sha: string): Promise<Tree | null> {
  const tree = await db.githubStagedTree.findFirst({
    where: { tenant, repo: repo.fullName, sha },
  })
  if (tree === null) return null
  const rows = await db.githubStagedEntry.findMany({
    where: { tenant, treeSha: sha },
    orderBy: { seq: 'asc' },
  })
  const out: Tree = new Map()
  for (const r of rows) out.set(r.path, Buffer.from(r.data))
  return out
}

// Build a tree from a base plus the caller's entries. A null sha is git's
// delete, `content` is the inline form, and a bare sha names a blob the caller
// wrote earlier.
//
// The base is `base_tree` when the caller named one, which is how a client
// composes several staged trees into one commit: without it the second tree
// starts from the branch again and silently drops everything the first one
// added. A name that matches no staged tree falls back to the branch rather
// than failing, which is what the fake this replaces did.
const createTree = withRepo(async (ctx, repo) => {
  const body = jsonBodyOf(ctx)
  // `tree` is required, and a body that omits it or spells it as anything but
  // an array is refused rather than read as "no entries". Coercing it to an
  // empty list stages a full copy of the base and answers 201, so a caller's
  // typo reads as a successful write and only shows up later as a commit that
  // changed nothing.
  if (!Array.isArray(body.tree)) {
    return fail(422, 'Invalid request.\n\n"tree" wasn\'t supplied.')
  }
  const entries = body.tree
  const base = str(body, 'base_tree')
  const staged = base === '' ? null : await stagedTree(ctx.db, ctx.tenant, repo, base)
  const files = staged ?? (await treeOfBranch(ctx.db, ctx.tenant, repo, repo.defaultBranch))
  for (const raw of entries) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
    const entry = raw as Record<string, unknown>
    const path = String(entry.path ?? '').replace(/^\/+|\/+$/g, '')
    if (path === '') continue
    if ('sha' in entry && entry.sha === null) {
      files.delete(path)
    } else if (entry.content !== undefined && entry.content !== null) {
      files.set(path, Buffer.from(String(entry.content), 'utf8'))
    } else if (typeof entry.sha === 'string' && entry.sha !== '') {
      const blob = await blobBySha(ctx.db, ctx.tenant, repo, entry.sha)
      if (blob === null) return fail(422, `Tree entry ${path} has an unknown sha`)
      files.set(path, blob)
    }
  }
  const count = await ctx.db.githubStagedTree.count({
    where: { tenant: ctx.tenant, repo: repo.fullName },
  })
  const sha = treeSha(`${repo.fullName}:${String(count)}`)
  await ctx.db.githubStagedTree.create({
    data: { tenant: ctx.tenant, repo: repo.fullName, sha, seq: count },
  })
  let seq = 0
  for (const [path, data] of files) {
    await ctx.db.githubStagedEntry.create({
      data: { tenant: ctx.tenant, treeSha: sha, path, data: new Uint8Array(data), seq },
    })
    seq += 1
  }
  return { status: 201, body: { sha, tree: [] } }
})

// The touched set is computed against the DEFAULT branch, which is what the
// python fake did and what a golden records, even when the commit is later
// pointed at another branch.
const createCommit = withRepo(async (ctx, repo) => {
  const body = jsonBodyOf(ctx)
  const tree = str(body, 'tree')
  const staged = await stagedTree(ctx.db, ctx.tenant, repo, tree)
  if (staged === null) return fail(422, 'Invalid request.\n\n"tree" is invalid.')
  const current = await treeOfBranch(ctx.db, ctx.tenant, repo, repo.defaultBranch)
  const touched = new Set<string>()
  for (const p of staged.keys()) if (!current.has(p)) touched.add(p)
  for (const p of current.keys()) if (!staged.has(p)) touched.add(p)
  for (const [p, d] of staged) {
    const was = current.get(p)
    if (was === undefined || !was.equals(d)) touched.add(p)
  }
  const message = str(body, 'message') === '' ? 'Update' : str(body, 'message')
  const author = bodyPerson(body, 'author')
  if (author === INVALID_PERSON) return fail(422, 'Invalid request.\n\n"author" is invalid.')
  const committer = bodyPerson(body, 'committer')
  if (committer === INVALID_PERSON) return fail(422, 'Invalid request.\n\n"committer" is invalid.')
  const commit = await recordCommit(
    ctx.db,
    ctx.tenant,
    repo,
    message,
    [...touched].sort(),
    repo.defaultBranch,
    tree,
    { author, committer },
  )
  const people = commitPeople({
    authorJson: personJson(author),
    committerJson: personJson(committer),
  })
  return {
    status: 201,
    body: { sha: commit.sha, message, tree: { sha: tree }, ...(people ?? {}) },
  }
})

// A branch starts as a copy of whatever the base sha resolves to, which is what
// a branch is: another name for one commit and every file reachable from it.
// Its own history starts there, so the two do not share future commits.
const createRef = withRepo(async (ctx, repo) => {
  const body = jsonBodyOf(ctx)
  const ref = str(body, 'ref').replace(/^\/+|\/+$/g, '')
  if (!ref.startsWith('refs/heads/')) return fail(422, 'Invalid request.\n\n"ref" is invalid.')
  const name = ref.slice('refs/heads/'.length)
  if (name === '') return fail(422, 'Invalid request.\n\n"ref" is invalid.')
  const names = await branchNames(ctx.db, ctx.tenant, repo)
  if (names.includes(name)) return fail(422, 'Reference already exists')
  const base = await branchFor(ctx.db, ctx.tenant, repo, str(body, 'sha'))
  if (base === null) return fail(422, 'Object does not exist')
  // Recorded before the files are copied, because a branch off an empty
  // repository copies none and would otherwise not exist at all.
  await addBranch(ctx.db, ctx.tenant, repo.fullName, name)
  const files = await treeOfBranch(ctx.db, ctx.tenant, repo, base)
  let seq = 0
  for (const [path, data] of files) {
    await ctx.db.githubFile.create({
      data: {
        tenant: ctx.tenant,
        repo: repo.fullName,
        branch: name,
        path,
        data: new Uint8Array(data),
        seq,
      },
    })
    seq += 1
  }
  const head = await commitList(ctx.db, ctx.tenant, repo, name)
  return {
    status: 201,
    body: { ref: `refs/heads/${name}`, object: { sha: head[0]?.sha ?? '', type: 'commit' } },
  }
})

// Moving a branch is what makes a staged tree visible.
const updateRef = withRepo(async (ctx, repo) => {
  const ref = param(ctx, 'ref').replace(/^\/+|\/+$/g, '')
  const name = ref.startsWith('heads/') ? ref.slice('heads/'.length) : ''
  const names = await branchNames(ctx.db, ctx.tenant, repo)
  if (name === '' || !names.includes(name)) return fail(422, 'Reference does not exist')
  const body = jsonBodyOf(ctx)
  const sha = str(body, 'sha')
  const commit = await ctx.db.githubCommit.findFirst({
    where: { tenant: ctx.tenant, repo: repo.fullName, sha },
  })
  if (commit === null || commit.treeSha === '') {
    return fail(422, 'Invalid request.\n\n"sha" is invalid.')
  }
  const staged = await stagedTree(ctx.db, ctx.tenant, repo, commit.treeSha)
  if (staged === null) return fail(422, 'Invalid request.\n\n"sha" is invalid.')
  await ctx.db.githubFile.deleteMany({
    where: { tenant: ctx.tenant, repo: repo.fullName, branch: name },
  })
  for (const [path, data] of staged) {
    await writeFile(ctx.db, ctx.tenant, repo, name, path, data)
  }
  return { status: 200, body: { ref: `refs/${ref}`, object: { sha, type: 'commit' } } }
})

// Looked up in the default branch's history rather than in the commit table,
// because the root commit is synthesized from the tree and never stored: a
// caller resolving a ref and then asking for that commit would 404 on the one
// commit every repository has. A commit that named no tree of its own points
// at the whole-tree sha, which is what a write through /contents produces.
const gitCommit = withRepo(async (ctx, repo) => {
  const sha = param(ctx, 'sha')
  const history = await commitList(ctx.db, ctx.tenant, repo, repo.defaultBranch)
  const row = history.find((c) => c.sha === sha)
  if (row === undefined) return fail(404, 'Not Found')
  return {
    status: 200,
    body: {
      sha,
      message: row.message,
      tree: { sha: row.treeSha === '' ? treeSha('') : row.treeSha },
      ...(commitPeople(row) ?? {}),
    },
  }
})

async function headSha(ctx: Ctx<C>, repo: RepoRow, branch: string): Promise<string> {
  const head = await commitList(ctx.db, ctx.tenant, repo, branch)
  return head[0]?.sha ?? ''
}

// `git/ref/<full-ref>` returns ONE object and `git/refs/<prefix>` a LIST of
// everything beneath it. They are different endpoints, and a caller picks
// whichever it expects, so serving only the singular makes the plural read as
// "no such ref". A prefix that matches nothing is a 404 rather than an empty
// list, which is what the vendor answers.
const showRef = withRepo(async (ctx, repo) => {
  const ref = param(ctx, 'ref').replace(/^\/+|\/+$/g, '')
  const name = ref.startsWith('heads/') ? ref.slice('heads/'.length) : ''
  const names = await branchNames(ctx.db, ctx.tenant, repo)
  if (!names.includes(name)) return fail(404, 'Not Found')
  return {
    status: 200,
    body: { ref: `refs/${ref}`, object: { sha: await headSha(ctx, repo, name), type: 'commit' } },
  }
})

const listRefs = withRepo(async (ctx, repo) => {
  const prefix = param(ctx, 'ref').replace(/^\/+|\/+$/g, '')
  const items: JsonValue[] = []
  for (const name of await branchNames(ctx.db, ctx.tenant, repo)) {
    if (!`heads/${name}`.startsWith(prefix)) continue
    items.push({
      ref: `refs/heads/${name}`,
      object: { sha: await headSha(ctx, repo, name), type: 'commit' },
    })
  }
  if (items.length === 0) return fail(404, 'Not Found')
  return { status: 200, body: items }
})

export function gitRoutes(): KitRoute<C>[] {
  return everywhere<C>(API_PREFIXES, (p) => [
    route<C>('POST', `${p}/repos/:owner/:repo/git/trees`, authedRoute(createTree), { write: true }),
    route<C>('POST', `${p}/repos/:owner/:repo/git/commits`, authedRoute(createCommit), {
      write: true,
    }),
    route<C>('GET', `${p}/repos/:owner/:repo/git/commits/:sha`, authedRoute(gitCommit)),
    route<C>('POST', `${p}/repos/:owner/:repo/git/refs`, authedRoute(createRef), { write: true }),
    route<C>('PATCH', `${p}/repos/:owner/:repo/git/refs/*ref`, authedRoute(updateRef), {
      write: true,
    }),
    route<C>('GET', `${p}/repos/:owner/:repo/git/ref/*ref`, authedRoute(showRef)),
    route<C>('GET', `${p}/repos/:owner/:repo/git/refs/*ref`, authedRoute(listRefs)),
  ])
}
