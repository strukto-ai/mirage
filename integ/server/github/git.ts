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
import type { CommitRow } from './wire.ts'
import {
  addBranch,
  branchFor,
  branchNames,
  commitList,
  commitsBySha,
  headOf,
  reaches,
  stageTree,
  stagedTree,
  treeOfBranch,
  visibleHeadOf,
} from './store.ts'
import type { RepoRow } from './store.ts'
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
  return {
    status: 201,
    body: { sha: await stageTree(ctx.db, ctx.tenant, repo, files), tree: [] },
  }
})

// The touched set is computed against the DEFAULT branch, which is what the
// python fake did and what a golden records, even when the commit is later
// pointed at another branch.
//
// The commit is born dangling: it advances no ref, because in git creating a
// commit and moving a branch onto it are two steps, and a client that stages
// several before touching any ref depends on that. `parents` is read from the
// body as the API states it (first parent only, which is all a linear fake
// needs); absent, the default branch's head stands in, which is the base the
// touched set above is computed against.
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
  // A present `parents` is the caller's answer even when it is empty: `[]` is
  // how the API spells a root commit, and re-parenting one onto the branch
  // head would change both its sha and its ancestry. Only an ABSENT field
  // falls back to where the default branch currently points.
  const parents = body.parents
  const parent = Array.isArray(parents)
    ? typeof parents[0] === 'string'
      ? parents[0]
      : ''
    : await visibleHeadOf(ctx.db, ctx.tenant, repo, repo.defaultBranch)
  const commit = await recordCommit(
    ctx.db,
    ctx.tenant,
    repo,
    message,
    [...touched].sort(),
    repo.defaultBranch,
    tree,
    { author, committer },
    parent,
    false,
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

// A branch starts as another name for whatever the base resolves to, which is
// what a branch is: one pointer and every file reachable from it. It takes
// that point as its head, so it SHARES the history behind it and diverges only
// in what each ref is pointed at next.
//
// The base is resolved as a COMMIT OBJECT first and only then as a ref,
// because those are two different questions and only the second one needs a
// branch to already contain the commit. A client that commits and then creates
// the branch at that sha is naming an object no ref has reached yet, and
// asking which existing branch holds it answers "none" for a commit that is
// perfectly real.
const createRef = withRepo(async (ctx, repo) => {
  const body = jsonBodyOf(ctx)
  const ref = str(body, 'ref').replace(/^\/+|\/+$/g, '')
  if (!ref.startsWith('refs/heads/')) return fail(422, 'Invalid request.\n\n"ref" is invalid.')
  const name = ref.slice('refs/heads/'.length)
  if (name === '') return fail(422, 'Invalid request.\n\n"ref" is invalid.')
  const names = await branchNames(ctx.db, ctx.tenant, repo)
  if (names.includes(name)) return fail(422, 'Reference already exists')
  const asked = str(body, 'sha')
  const object =
    asked === ''
      ? null
      : ((await ctx.db.githubCommit.findFirst({
          where: { tenant: ctx.tenant, repo: repo.fullName, sha: asked },
        })) as CommitRow | null)
  // A commit carries its own tree, so the branch is populated from the commit
  // that was named rather than from a branch that happens to hold it. Those are
  // different answers whenever that branch has moved on since, and reading the
  // branch reported the newer files under the older sha.
  const staged = object === null ? null : await stagedTree(ctx.db, ctx.tenant, repo, object.treeSha)
  if (object !== null && staged === null) return fail(422, 'Object does not exist')
  // Only a sha no commit row answers for is resolved as a ref, which is how a
  // branch name, HEAD, the empty string and the synthesized root all arrive.
  const base = object !== null ? null : await branchFor(ctx.db, ctx.tenant, repo, asked)
  if (object === null && base === null) return fail(422, 'Object does not exist')
  // Recorded before the files are copied, because a branch off an empty
  // repository copies none and would otherwise not exist at all.
  await addBranch(ctx.db, ctx.tenant, repo.fullName, name)
  const startAt =
    object !== null ? object.sha : base === null ? '' : await headOf(ctx.db, ctx.tenant, repo, base)
  if (startAt !== '') {
    await ctx.db.githubBranch.updateMany({
      where: { tenant: ctx.tenant, repo: repo.fullName, name },
      data: { headSha: startAt },
    })
  }
  const files = staged ?? (await treeOfBranch(ctx.db, ctx.tenant, repo, base ?? repo.defaultBranch))
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

// Moving a branch is a pointer write, which is all a ref has ever been. The
// commits a branch has are the ones reachable from that pointer, so this
// function neither owns nor rewrites any commit row: pointing a second ref at
// one commit shares it, pointing a ref backwards abandons the commits above
// (they stay resolvable by sha, dangling, exactly as the vendor keeps them),
// and neither case needs a rule of its own. A move that would abandon
// anything is refused unless the body says `force`, and the test is exact:
// a fast forward is one where the branch's current head is still reachable by
// walking first parents back from the requested commit.
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
  if (commit === null) return fail(422, 'Invalid request.\n\n"sha" is invalid.')
  // Every commit records a tree, so the ref is restored to the snapshot the
  // named commit took. A commit written through /contents used to record none,
  // and was refused here as though it were not a commit at all.
  const staged = await stagedTree(ctx.db, ctx.tenant, repo, commit.treeSha)
  if (staged === null) return fail(422, 'Invalid request.\n\n"sha" is invalid.')
  // Refused before anything is written, so a refused update changes nothing.
  const head = await visibleHeadOf(ctx.db, ctx.tenant, repo, name)
  const byId = await commitsBySha(ctx.db, ctx.tenant, repo)
  if (!reaches(sha, head, byId) && body.force !== true) {
    return fail(422, 'Update is not a fast forward')
  }
  await ctx.db.githubBranch.updateMany({
    where: { tenant: ctx.tenant, repo: repo.fullName, name },
    data: { headSha: sha },
  })
  await ctx.db.githubFile.deleteMany({
    where: { tenant: ctx.tenant, repo: repo.fullName, branch: name },
  })
  for (const [path, data] of staged) {
    await writeFile(ctx.db, ctx.tenant, repo, name, path, data)
  }
  return { status: 200, body: { ref: `refs/${ref}`, object: { sha, type: 'commit' } } }
})

// An object is resolved by sha, not by finding a branch that still lists it:
// a commit created but not yet pointed at, and a commit a reset abandoned,
// are both real objects the vendor still answers for. Only the synthesized
// root has to be searched for, because it is derived from a branch's content
// rather than stored, and a caller resolving a ref on a fresh repository asks
// for exactly that one. It is also the only row that names no tree, which is
// why the whole-tree sha still stands in for one here.
const gitCommit = withRepo(async (ctx, repo) => {
  const sha = param(ctx, 'sha')
  const stored = (await ctx.db.githubCommit.findFirst({
    where: { tenant: ctx.tenant, repo: repo.fullName, sha },
  })) as CommitRow | null
  let row = stored
  if (row === null) {
    for (const branch of await branchNames(ctx.db, ctx.tenant, repo)) {
      const history = await commitList(ctx.db, ctx.tenant, repo, branch)
      const hit = history.find((c) => c.sha === sha)
      if (hit !== undefined) {
        row = hit
        break
      }
    }
  }
  if (row === null) return fail(404, 'Not Found')
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
