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
import {
  INVALID_PERSON,
  bodyPerson,
  commitSha,
  defaultPerson,
  gitCommitJson,
  nodeId,
  parsePerson,
  personJson,
} from './wire.ts'
import type { CommitRow } from './wire.ts'
import {
  addBranch,
  blobBySha,
  branchLinks,
  branchNames,
  commitList,
  commitTreeId,
  commitsBySha,
  headOf,
  keepRoot,
  keepTree,
  peeled,
  reaches,
  repoIsEmpty,
  resolveRef,
  snapshotAt,
  stageTree,
  stagedTree,
  storeBlob,
  subtreeOf,
  tagObject,
  tagRefs,
  treeAt,
  treeById,
  treeOfBranch,
  visibleHeadOf,
} from './store.ts'
import type { RepoRow, TagRow, TreeAtId } from './store.ts'
import {
  authedRoute,
  everywhere,
  fail,
  jsonBodyOf,
  pagedReply,
  param,
  route,
  str,
  withRepo,
} from './http.ts'
import { base64Bytes, recordCommit, writeFile } from './contents.ts'
import { rebuildOnPush } from './pages.ts'
import { stripSlash } from '../kit/typescript/index.ts'

// A blob is written on its own, before any tree names it, which is how a
// client builds a commit from the git database API: blobs, then a tree of
// them, then the commit. `content` is text unless `encoding` says base64, and
// the answer is the blob's git sha, the one `git hash-object` gives. An empty
// repository refuses it, as it refuses every git database call: GitHub
// documents the 409 and points at a contents write to start one. The wording
// of a refused field is the fake's own, not measured.
const createBlob = withRepo(async (ctx, repo) => {
  if (await repoIsEmpty(ctx.db, ctx.tenant, repo)) return fail(409, 'Git Repository is empty.')
  const body = jsonBodyOf(ctx)
  const content = body.content
  if (content === undefined || content === null) {
    return fail(422, 'Invalid request.\n\n"content" wasn\'t supplied.')
  }
  if (typeof content !== 'string') return fail(422, 'Invalid request.\n\n"content" is invalid.')
  const encoding = str(body, 'encoding', 'utf-8')
  if (encoding !== 'utf-8' && encoding !== 'base64') {
    return fail(422, 'Invalid request.\n\n"encoding" is invalid.')
  }
  const data = encoding === 'base64' ? base64Bytes(content) : Buffer.from(content, 'utf8')
  if (data === null) return fail(422, 'Invalid request.\n\n"content" is invalid.')
  const sha = await storeBlob(ctx.db, ctx.tenant, repo, data)
  return {
    status: 201,
    body: { url: `https://api.github.com/repos/${repo.fullName}/git/blobs/${sha}`, sha },
  }
})

async function baseTree(
  db: C,
  tenant: string,
  repo: RepoRow,
  base: string,
): Promise<TreeAtId | null> {
  const named = await treeById(db, tenant, repo, base)
  if (named !== null || base.length !== 40) return named
  const commit = await resolveRef(db, tenant, repo, base)
  if (commit === null || commit.branch !== null) return null
  const tree = await snapshotAt(db, tenant, repo, commit)
  return tree === null ? null : { ...tree, at: '' }
}

// Build a tree from a base plus the caller's entries. A null sha is git's
// delete, `content` is the inline form, a bare sha names a blob the caller
// wrote earlier, and a `commit` entry is a gitlink to the commit it names.
//
// The base is `base_tree` when the caller named one, which is how a client
// composes several staged trees into one commit: without it the second tree
// starts from the branch again and silently drops everything the first one
// added. Any tree id the fake reported names one, a commit's or one
// directory's included, and so does a commit sha, read as its root tree: the
// sha a ref's tree listing reports is its commit. An unknown base is refused
// rather than silently substituting another tree. The validation wording is
// the fake's own.
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
  const named = base === '' ? null : await baseTree(ctx.db, ctx.tenant, repo, base)
  if (base !== '' && named === null) {
    return fail(422, 'Invalid request.\n\n"base_tree" is invalid.')
  }
  const { files, links } =
    named === null
      ? {
          files: await treeOfBranch(ctx.db, ctx.tenant, repo, repo.defaultBranch),
          links: await branchLinks(ctx.db, ctx.tenant, repo, repo.defaultBranch),
        }
      : subtreeOf(named, named.at)
  for (const raw of entries) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
    const entry = raw as Record<string, unknown>
    const path = stripSlash(String(entry.path ?? ''))
    if (path === '') continue
    if ('sha' in entry && entry.sha === null) {
      files.delete(path)
      links.delete(path)
    } else if (entry.content !== undefined && entry.content !== null) {
      files.set(path, Buffer.from(String(entry.content), 'utf8'))
      links.delete(path)
    } else if (typeof entry.sha === 'string' && entry.sha !== '' && entry.type === 'commit') {
      links.set(path, entry.sha)
      files.delete(path)
    } else if (typeof entry.sha === 'string' && entry.sha !== '') {
      const blob = await blobBySha(ctx.db, ctx.tenant, repo, entry.sha)
      if (blob === null) return fail(422, `Tree entry ${path} has an unknown sha`)
      files.set(path, blob)
      links.delete(path)
    }
  }
  return {
    status: 201,
    body: { sha: await stageTree(ctx.db, ctx.tenant, repo, files, links), tree: [] },
  }
})

// The commit is born dangling: it advances no ref, because in git creating a
// commit and moving a branch onto it are two steps, and a client that stages
// several before touching any ref depends on that. `parents` is read from the
// body as the API states it, every one in order, so a merge names both of its
// parents; absent, the default branch's head stands in. What it changed is its
// tree against its parent's, which every reader derives. The tree is any id
// the fake reported, and one no write has staged yet, a seeded branch's or
// one directory's, is staged here so the commit can be read back on its own.
const createCommit = withRepo(async (ctx, repo) => {
  const body = jsonBodyOf(ctx)
  const tree = str(body, 'tree')
  const named = await treeById(ctx.db, ctx.tenant, repo, tree)
  if (named === null) {
    return fail(422, 'Invalid request.\n\n"tree" is invalid.')
  }
  const sub = subtreeOf(named, named.at)
  await stageTree(ctx.db, ctx.tenant, repo, sub.files, sub.links)
  const message = str(body, 'message') === '' ? 'Update' : str(body, 'message')
  const author = bodyPerson(body, 'author')
  if (author === INVALID_PERSON) return fail(422, 'Invalid request.\n\n"author" is invalid.')
  const committer = bodyPerson(body, 'committer')
  if (committer === INVALID_PERSON) return fail(422, 'Invalid request.\n\n"committer" is invalid.')
  // A present `parents` is the caller's answer even when it is empty: `[]` is
  // how the API spells a root commit, and re-parenting one onto the branch
  // head would change both its sha and its ancestry. Only an ABSENT field
  // falls back to where the default branch currently points.
  const parents = Array.isArray(body.parents)
    ? body.parents.filter((sha): sha is string => typeof sha === 'string')
    : [await visibleHeadOf(ctx.db, ctx.tenant, repo, repo.defaultBranch)]
  const commit = await recordCommit(
    ctx.db,
    ctx.tenant,
    repo,
    message,
    repo.defaultBranch,
    tree,
    { author, committer },
    parents,
    false,
  )
  return { status: 201, body: gitCommitJson(repo.fullName, commit, tree) }
})

// A branch starts as another name for whatever the base resolves to, which is
// what a branch is: one pointer and every file reachable from it. It takes
// that point as its head, so it SHARES the history behind it and diverges only
// in what each ref is pointed at next.
//
// The base is resolved as what it names, a commit object or a branch, and
// never as "the branch that holds this sha": a client that commits and then
// creates the branch at that sha is naming an object no ref has reached yet,
// and asking which existing branch holds it answers "none" for a commit that
// is perfectly real.
const createRef = withRepo(async (ctx, repo) => {
  const body = jsonBodyOf(ctx)
  const ref = stripSlash(str(body, 'ref'))
  if (ref.startsWith('refs/tags/')) {
    return await createTagRef(ctx, repo, ref.slice('refs/tags/'.length), str(body, 'sha'))
  }
  if (!ref.startsWith('refs/heads/')) return fail(422, 'Invalid request.\n\n"ref" is invalid.')
  const name = ref.slice('refs/heads/'.length)
  if (name === '') return fail(422, 'Invalid request.\n\n"ref" is invalid.')
  const names = await branchNames(ctx.db, ctx.tenant, repo)
  if (names.includes(name)) return fail(422, 'Reference already exists')
  const at = await resolveRef(ctx.db, ctx.tenant, repo, str(body, 'sha'))
  // A commit carries its own tree, so the branch is populated from the commit
  // that was named rather than from a branch that happens to hold it. Those are
  // different answers whenever that branch has moved on since, and reading the
  // branch reported the newer files under the older sha.
  const files = at === null ? null : await treeAt(ctx.db, ctx.tenant, repo, at)
  if (at === null || files === null) return fail(422, 'Object does not exist')
  // Recorded before the files are copied, because a branch off an empty
  // repository copies none and would otherwise not exist at all.
  await addBranch(ctx.db, ctx.tenant, repo.fullName, name)
  // A synthesized root is no stored commit, so a branch started on one keeps
  // no head and derives the same root from the files it is given.
  const named = at.history[0]
  const startAt =
    at.branch !== null
      ? await headOf(ctx.db, ctx.tenant, repo, at.branch)
      : named !== undefined && named.treeSha !== ''
        ? named.sha
        : ''
  if (startAt !== '') {
    await ctx.db.githubBranch.updateMany({
      where: { tenant: ctx.tenant, repo: repo.fullName, name },
      data: { headSha: startAt },
    })
  }
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
// walking any parent back from the requested commit, so a merge of the
// branch fast-forwards it.
const updateRef = withRepo(async (ctx, repo) => {
  const ref = stripSlash(param(ctx, 'ref'))
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
  await keepRoot(ctx.db, ctx.tenant, repo, name)
  await ctx.db.githubBranch.updateMany({
    where: { tenant: ctx.tenant, repo: repo.fullName, name },
    data: { headSha: sha },
  })
  await keepTree(ctx.db, ctx.tenant, repo, name)
  await ctx.db.githubFile.deleteMany({
    where: { tenant: ctx.tenant, repo: repo.fullName, branch: name },
  })
  for (const [path, data] of staged) {
    await writeFile(ctx.db, ctx.tenant, repo, name, path, data)
  }
  await rebuildOnPush(ctx.db, ctx.tenant, repo.fullName, name)
  return { status: 200, body: { ref: `refs/${ref}`, object: { sha, type: 'commit' } } }
})

// An object is resolved by sha, not by finding a branch that still lists it:
// a commit created but not yet pointed at, and a commit a reset abandoned,
// are both real objects the vendor still answers for. Only the synthesized
// root has to be searched for, because it is derived from a branch's content
// rather than stored, and a caller resolving a ref on a fresh repository asks
// for exactly that one. It is also the only row that names no tree, so its
// tree is the id of the files it holds.
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
  const tree = await commitTreeId(ctx.db, ctx.tenant, repo, row)
  return { status: 200, body: gitCommitJson(repo.fullName, row, tree) }
})

async function headSha(ctx: Ctx<C>, repo: RepoRow, branch: string): Promise<string> {
  const head = await commitList(ctx.db, ctx.tenant, repo, branch)
  return head[0]?.sha ?? ''
}

// What a full sha names here, for a tag to point at: an annotated tag object
// or a commit, by its whole sha, as git objects are named. Null for anything
// else, which is how GitHub's "Object does not exist" reads.
async function objectType(ctx: Ctx<C>, repo: RepoRow, sha: string): Promise<string | null> {
  if ((await tagObject(ctx.db, ctx.tenant, repo, sha)) !== null) return 'tag'
  const at = await resolveRef(ctx.db, ctx.tenant, repo, sha)
  return at !== null && at.branch === null && at.history[0]?.sha === sha ? 'commit' : null
}

function tagJson(repo: RepoRow, row: TagRow): JsonValue {
  const api = `https://api.github.com/repos/${repo.fullName}`
  const kind = row.objectType === 'tag' ? 'tags' : 'commits'
  return {
    node_id: nodeId('03:Tag', row.sha),
    tag: row.tag,
    sha: row.sha,
    url: `${api}/git/tags/${row.sha}`,
    message: row.message,
    tagger: { ...(parsePerson(row.taggerJson) ?? defaultPerson()) },
    object: {
      type: row.objectType,
      sha: row.objectSha,
      url: `${api}/git/${kind}/${row.objectSha}`,
    },
    verification: {
      verified: false,
      reason: 'unsigned',
      signature: null,
      payload: null,
      verified_at: null,
    },
  }
}

// An annotated tag object: a name, a message and a tagger around a commit or
// another tag, stored by a sha of its content, and pointed at by no ref until
// a caller creates `refs/tags/<name>` at it. That is git's two steps, and
// GitHub's.
const createTag = withRepo(async (ctx, repo) => {
  const body = jsonBodyOf(ctx)
  const missing = ['tag', 'message', 'object', 'type'].filter(
    (key) => typeof body[key] !== 'string',
  )
  if (missing.length > 0) {
    const names = missing.map((key) => `"${key}"`).join(', ')
    const verb = missing.length === 1 ? "wasn't" : "weren't"
    return fail(422, `Invalid request.\n\n${names} ${verb} supplied.`)
  }
  const object = str(body, 'object')
  const type = str(body, 'type')
  if ((await objectType(ctx, repo, object)) !== type) return fail(422, 'Object does not exist')
  const tagger = bodyPerson(body, 'tagger')
  if (tagger === INVALID_PERSON) return fail(422, 'Invalid request.\n\n"tagger" is invalid.')
  const taggerJson = personJson(tagger ?? defaultPerson())
  const row: TagRow = {
    sha: '',
    tag: str(body, 'tag'),
    message: str(body, 'message'),
    objectSha: object,
    objectType: type,
    taggerJson,
  }
  row.sha = commitSha(
    ['tag', repo.fullName, row.tag, object, type, row.message, taggerJson].join('\0'),
  )
  if ((await tagObject(ctx.db, ctx.tenant, repo, row.sha)) === null) {
    const count = await ctx.db.githubTag.count({
      where: { tenant: ctx.tenant, repo: repo.fullName },
    })
    await ctx.db.githubTag.create({
      data: { tenant: ctx.tenant, repo: repo.fullName, ...row, seq: count },
    })
  }
  return { status: 201, body: tagJson(repo, row) }
})

const getTag = withRepo(async (ctx, repo) => {
  const row = await tagObject(ctx.db, ctx.tenant, repo, param(ctx, 'sha'))
  return row === null ? fail(404, 'Not Found') : { status: 200, body: tagJson(repo, row) }
})

// A tag ref names a commit or an annotated tag object by its whole sha.
async function createTagRef(ctx: Ctx<C>, repo: RepoRow, name: string, sha: string) {
  if (name === '') return fail(422, 'Invalid request.\n\n"ref" is invalid.')
  if ((await tagRefs(ctx.db, ctx.tenant, repo)).some((row) => row.name === name)) {
    return fail(422, 'Reference already exists')
  }
  const type = await objectType(ctx, repo, sha)
  if (type === null) return fail(422, 'Object does not exist')
  const count = await ctx.db.githubTagRef.count({
    where: { tenant: ctx.tenant, repo: repo.fullName },
  })
  await ctx.db.githubTagRef.create({
    data: { tenant: ctx.tenant, repo: repo.fullName, name, sha, seq: count },
  })
  return { status: 201, body: { ref: `refs/tags/${name}`, object: { sha, type } } }
}

// A repository's tags as `GET /tags` lists them: newest name first, as
// GitHub's list reads (measured 2026-09-29 on octocat/linguist), each peeled
// to the commit it names.
const listTags = withRepo(async (ctx, repo) => {
  const api = `https://api.github.com/repos/${repo.fullName}`
  const rows = (await tagRefs(ctx.db, ctx.tenant, repo)).sort((a, b) => (a.name < b.name ? 1 : -1))
  const items: JsonValue[] = []
  for (const row of rows) {
    const commit = await peeled(ctx.db, ctx.tenant, repo, row.sha)
    items.push({
      name: row.name,
      zipball_url: `${api}/zipball/refs/tags/${row.name}`,
      tarball_url: `${api}/tarball/refs/tags/${row.name}`,
      commit: { sha: commit, url: `${api}/commits/${commit}` },
      node_id: nodeId('03:Ref', `${String(repo.seq)}:refs/tags/${row.name}`),
    })
  }
  return pagedReply(ctx, items)
})

// Every ref the repository has, branches first and then tags, each as
// `heads/<name>` or `tags/<name>` with what it points at. A branch nothing has
// been committed to points nowhere, so it is no ref.
async function refsOf(
  ctx: Ctx<C>,
  repo: RepoRow,
): Promise<Array<{ ref: string; sha: string; type: string }>> {
  const out: Array<{ ref: string; sha: string; type: string }> = []
  for (const name of await branchNames(ctx.db, ctx.tenant, repo)) {
    const sha = await headSha(ctx, repo, name)
    if (sha !== '') out.push({ ref: `heads/${name}`, sha, type: 'commit' })
  }
  for (const row of await tagRefs(ctx.db, ctx.tenant, repo)) {
    const tag = await tagObject(ctx.db, ctx.tenant, repo, row.sha)
    out.push({ ref: `tags/${row.name}`, sha: row.sha, type: tag === null ? 'commit' : 'tag' })
  }
  return out
}

// `git/ref/<full-ref>` returns ONE object and `git/refs/<prefix>` a LIST of
// everything beneath it. They are different endpoints, and a caller picks
// whichever it expects, so serving only the singular makes the plural read as
// "no such ref". A prefix that matches nothing is a 404 rather than an empty
// list, which is what the vendor answers.
//
// An empty repository has no refs at all, and both endpoints say so with a 409
// before reading the ref, whatever it names: a branch, a tag, nothing that
// exists, or no prefix. Answering from the branch row instead reported the
// default branch at an empty sha, which no client can resolve. For the same
// reason a branch nothing has been committed to is no ref once the repository
// has others: a ref names a commit, so that branch is missing, not at "".
const showRef = withRepo(async (ctx, repo) => {
  if (await repoIsEmpty(ctx.db, ctx.tenant, repo)) return fail(409, 'Git Repository is empty.')
  const ref = stripSlash(param(ctx, 'ref'))
  const hit = (await refsOf(ctx, repo)).find((row) => row.ref === ref)
  if (hit === undefined) return fail(404, 'Not Found')
  return { status: 200, body: { ref: `refs/${ref}`, object: { sha: hit.sha, type: hit.type } } }
})

const listRefs = withRepo(async (ctx, repo) => {
  if (await repoIsEmpty(ctx.db, ctx.tenant, repo)) return fail(409, 'Git Repository is empty.')
  const prefix = stripSlash(param(ctx, 'ref'))
  const items: JsonValue[] = (await refsOf(ctx, repo))
    .filter((row) => row.ref.startsWith(prefix))
    .map((row) => ({ ref: `refs/${row.ref}`, object: { sha: row.sha, type: row.type } }))
  if (items.length === 0) return fail(404, 'Not Found')
  return { status: 200, body: items }
})

export function gitRoutes(): KitRoute<C>[] {
  return everywhere<C>(API_PREFIXES, (p) => [
    route<C>('POST', `${p}/repos/:owner/:repo/git/blobs`, authedRoute(createBlob), { write: true }),
    route<C>('POST', `${p}/repos/:owner/:repo/git/trees`, authedRoute(createTree), { write: true }),
    route<C>('POST', `${p}/repos/:owner/:repo/git/commits`, authedRoute(createCommit), {
      write: true,
    }),
    route<C>('GET', `${p}/repos/:owner/:repo/git/commits/:sha`, authedRoute(gitCommit)),
    route<C>('POST', `${p}/repos/:owner/:repo/git/tags`, authedRoute(createTag), { write: true }),
    route<C>('GET', `${p}/repos/:owner/:repo/git/tags/:sha`, authedRoute(getTag)),
    route<C>('GET', `${p}/repos/:owner/:repo/tags`, authedRoute(listTags)),
    route<C>('POST', `${p}/repos/:owner/:repo/git/refs`, authedRoute(createRef), { write: true }),
    route<C>('PATCH', `${p}/repos/:owner/:repo/git/refs/*ref`, authedRoute(updateRef), {
      write: true,
    }),
    route<C>('GET', `${p}/repos/:owner/:repo/git/ref/*ref`, authedRoute(showRef)),
    // Bare as well as with a prefix: the vendor lists every ref at `git/refs`,
    // and the splat below needs at least the slash.
    route<C>('GET', `${p}/repos/:owner/:repo/git/refs`, authedRoute(listRefs)),
    route<C>('GET', `${p}/repos/:owner/:repo/git/refs/*ref`, authedRoute(listRefs)),
  ])
}
