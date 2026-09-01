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

import { Prisma } from '../../generated/github/index.js'
import { deleteOrder, tenantWhere } from '../kit/typescript/index.ts'
import type { Dmmf, JsonValue } from '../kit/typescript/index.ts'
import { SEARCH_SIZE_LIMIT, config } from './config.ts'
import type { C } from './config.ts'
import { blobSha, commitSha, rootCommit, treeSha } from './wire.ts'
import type { CommitRow } from './wire.ts'

export interface RepoRow {
  fullName: string
  owner: string
  name: string
  defaultBranch: string
  metaJson: string
  truncated: boolean
  sourceDir: string
  sourceBranch: string
  seq: number
}

export type Tree = Map<string, Buffer>

export function scope(tenant: string): Record<string, JsonValue> {
  return tenantWhere(tenant, config.tenantKind)
}

// Every model that carries a `repo` foreign key, deepest dependency first. The
// repository lifecycle (rename copies then deletes, delete drops) has to touch
// all of them, and a hand-written list went stale twice. `deleteOrder` is the
// kit's own topological sort, the one its scoped reset uses, so this orders
// correctly as well as covering completely.
export function perRepoModels(): string[] {
  const dmmf = Prisma.dmmf as unknown as Dmmf
  const holdsRepo = new Set(
    dmmf.datamodel.models
      .filter(
        (m) =>
          m.name !== 'GithubRepo' && m.fields.some((f) => f.name === 'repo' && f.kind === 'scalar'),
      )
      .map((m) => m.name),
  )
  return deleteOrder(dmmf).filter((name) => holdsRepo.has(name))
}

// One typed door onto a delegate named at runtime. The two lifecycle walks are
// the only callers, and both do exactly these two things.
interface RepoScopedDelegate {
  updateMany(args: { where: Record<string, string>; data: { repo: string } }): Promise<unknown>
  deleteMany(args: { where: Record<string, string> }): Promise<unknown>
}

export function delegateFor(db: C, model: string): RepoScopedDelegate {
  const key = model.charAt(0).toLowerCase() + model.slice(1)
  const found = (db as unknown as Record<string, RepoScopedDelegate | undefined>)[key]
  if (found === undefined) throw new Error(`github fake: no delegate for ${model}`)
  return found
}

export async function repoByName(db: C, tenant: string, fullName: string): Promise<RepoRow | null> {
  return (await db.githubRepo.findUnique({
    where: { tenant_fullName: { tenant, fullName } },
  })) as RepoRow | null
}

export async function allRepos(db: C, tenant: string): Promise<RepoRow[]> {
  return (await db.githubRepo.findMany({
    where: scope(tenant),
    orderBy: { seq: 'asc' },
  })) as RepoRow[]
}

// Issues and pull requests share one counter, because on GitHub they share one
// number space: a repository with issue 1 numbers its first pull request 2.
export async function nextNumber(db: C, tenant: string, repo: RepoRow): Promise<number> {
  const where = { ...scope(tenant), repo: repo.fullName }
  const issue = await db.githubIssue.findFirst({ where, orderBy: { number: 'desc' } })
  const pull = await db.githubPull.findFirst({ where, orderBy: { number: 'desc' } })
  return Math.max(issue?.number ?? 0, pull?.number ?? 0) + 1
}

export function metaOf(repo: RepoRow): Record<string, JsonValue> {
  const parsed = JSON.parse(repo.metaJson) as JsonValue
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {}
}

// Branches, the default one first and the rest in name order.
export async function branchNames(db: C, tenant: string, repo: RepoRow): Promise<string[]> {
  const rows = await db.githubBranch.findMany({
    where: { ...scope(tenant), repo: repo.fullName },
    select: { name: true },
  })
  const seen = new Set(rows.map((r) => r.name))
  // The default branch is prepended whether or not a row exists for it, which
  // is what the fake this replaces did: renaming a repository's default branch
  // set the name without creating the branch, and the listing still led with
  // it.
  seen.add(repo.defaultBranch)
  const rest = [...seen].filter((b) => b !== repo.defaultBranch).sort()
  return [repo.defaultBranch, ...rest]
}

// A branch exists once it is recorded, independently of whether anything is on
// it. Idempotent, because every path that can reach a branch (seeding, repo
// creation, a fork, a new ref) may be reached twice for the same name.
export async function addBranch(
  db: C,
  tenant: string,
  fullName: string,
  name: string,
): Promise<void> {
  const count = await db.githubBranch.count({ where: { ...scope(tenant), repo: fullName } })
  await db.githubBranch.upsert({
    where: { tenant_repo_name: { tenant, repo: fullName, name } },
    update: {},
    create: { tenant, repo: fullName, name, seq: count },
  })
}

export async function treeOfBranch(
  db: C,
  tenant: string,
  repo: RepoRow,
  branch: string,
): Promise<Tree> {
  const rows = await db.githubFile.findMany({
    where: { ...scope(tenant), repo: repo.fullName, branch },
    orderBy: { seq: 'asc' },
  })
  const out: Tree = new Map()
  for (const r of rows) out.set(r.path, Buffer.from(r.data))
  return out
}

// A tree's bytes, as `path:blob` pairs in path order. This is the tree's whole
// identity, so it is what both the sha and any equality test are derived from.
export function treeFingerprint(files: Tree): string {
  return [...files.entries()]
    .map(([p, d]): [string, string] => [p, blobSha(d)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([p, b]) => `${p}:${b}`)
    .join('\0')
}

// Scoped to the repository, not just the tenant. A staged sha is unique per
// tenant, so a bare lookup accepted a tree staged in repository A while the
// caller was operating on repository B, and committing it copied A's files
// into B. The fake this replaces held `repo.trees` per repository, so a foreign
// sha was simply not found there.
export async function stagedTree(
  db: C,
  tenant: string,
  repo: RepoRow,
  sha: string,
): Promise<Tree | null> {
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

// Store one tree and answer its sha. The sha is the CONTENT's, the way git's
// is, so staging the same bytes twice is one object rather than two, and no id
// can be reproduced by a later tree landing in a slot a delete freed. The
// repository name is in the hash because the table's uniqueness is per tenant
// while every reader scopes by repository: without it two repositories holding
// the same file would collide on insert, and the second would be handed the
// first's rows.
export async function stageTree(
  db: C,
  tenant: string,
  repo: RepoRow,
  files: Tree,
): Promise<string> {
  const sha = treeSha(`${repo.fullName}\0${treeFingerprint(files)}`)
  const already = await db.githubStagedTree.findFirst({
    where: { tenant, repo: repo.fullName, sha },
  })
  if (already !== null) return sha
  const count = await db.githubStagedTree.count({ where: { tenant, repo: repo.fullName } })
  await db.githubStagedTree.create({ data: { tenant, repo: repo.fullName, sha, seq: count } })
  let seq = 0
  for (const [path, data] of files) {
    await db.githubStagedEntry.create({
      data: { tenant, treeSha: sha, path, data: new Uint8Array(data), seq },
    })
    seq += 1
  }
  return sha
}

// A ref is a branch name, HEAD, the empty string, or a commit sha belonging to
// one branch's history. A fully qualified spelling names the same branch: tool
// schemas advertise `refs/heads/main` and the live API accepts it on every
// ref-taking parameter.
export async function branchFor(
  db: C,
  tenant: string,
  repo: RepoRow,
  ref: string | null,
): Promise<string | null> {
  if (ref === null || ref === '' || ref === 'HEAD') return repo.defaultBranch
  let name = ref
  for (const qualifier of ['refs/heads/', 'heads/']) {
    if (name.startsWith(qualifier)) {
      name = name.slice(qualifier.length)
      break
    }
  }
  const branches = await branchNames(db, tenant, repo)
  if (branches.includes(name)) return name
  for (const branch of branches) {
    const list = await commitList(db, tenant, repo, branch)
    if (list.some((c) => c.sha === ref)) return branch
  }
  return null
}

export async function treeOf(
  db: C,
  tenant: string,
  repo: RepoRow,
  ref: string | null,
): Promise<Tree | null> {
  const branch = await branchFor(db, tenant, repo, ref)
  return branch === null ? null : await treeOfBranch(db, tenant, repo, branch)
}

// Every commit in one repository, keyed by sha, for walking a chain without a
// query per hop.
export async function commitsBySha(
  db: C,
  tenant: string,
  repo: RepoRow,
): Promise<Map<string, CommitRow>> {
  const rows = (await db.githubCommit.findMany({
    where: { ...scope(tenant), repo: repo.fullName },
    orderBy: { seq: 'asc' },
  })) as CommitRow[]
  const out = new Map<string, CommitRow>()
  for (const row of rows) out.set(row.sha, row)
  return out
}

// Walk first parents from a sha, newest first. Bounded by the map's size
// because a chain cannot visit a commit twice: `seen` is what stops a cycle,
// which a hand-built parent can always describe.
export function chainFrom(head: string, byId: Map<string, CommitRow>): CommitRow[] {
  const out: CommitRow[] = []
  const seen = new Set<string>()
  let at = head
  while (at !== '' && !seen.has(at)) {
    seen.add(at)
    const row = byId.get(at)
    if (row === undefined) break
    out.push(row)
    at = row.parentSha
  }
  return out
}

// Whether `ancestor` is reachable from `head` by first parents, which is the
// exact question a fast-forward asks. The empty sha is every commit's
// ancestor, since that is where a chain ends.
export function reaches(head: string, ancestor: string, byId: Map<string, CommitRow>): boolean {
  if (ancestor === '') return true
  // Walked as POINTERS rather than as rows, because the sha being looked for
  // may be one no row carries: a synthesized root is derived from a branch's
  // content and stored nowhere, yet it is what the ref endpoint answers with
  // and therefore what a commit on a seeded branch states as its parent.
  const seen = new Set<string>()
  let at = head
  while (at !== '' && !seen.has(at)) {
    if (at === ancestor) return true
    seen.add(at)
    at = byId.get(at)?.parentSha ?? ''
  }
  return false
}

// Where a ref answers it points, which is the stored head once anything has
// been committed and the synthesized root before that. A seeded branch carries
// files and no commit row, so its root is the only position it has, and both
// the fast-forward test and a new commit's default parent have to use it or
// they are reasoning about a ref the API never described.
export async function visibleHeadOf(
  db: C,
  tenant: string,
  repo: RepoRow,
  branch: string,
): Promise<string> {
  const stored = await headOf(db, tenant, repo, branch)
  if (stored !== '') return stored
  const tree = await treeOfBranch(db, tenant, repo, branch)
  return rootCommit([...tree.entries()].map(([p, d]): [string, string] => [p, blobSha(d)])).sha
}

export async function headOf(
  db: C,
  tenant: string,
  repo: RepoRow,
  branch: string,
): Promise<string> {
  const row = await db.githubBranch.findFirst({
    where: { ...scope(tenant), repo: repo.fullName, name: branch },
  })
  return row?.headSha ?? ''
}

// One branch's commits, newest first: the chain its ref points at, and under
// it a synthetic root derived from the branch's CONTENT rather than the
// repository's name, so that a mirror of a repository has the same root sha as
// its source. Two branches differ in that root exactly when their trees
// differ. The chain is walked rather than filtered by a column, so a commit
// two refs share is on both lists and a commit a reset abandoned is on
// neither, without either case being written down anywhere.
//
// That synthetic root is the floor for a chain that does not reach one of its
// own, not a parent stapled under every history. A chain ENDING at a stored
// commit with no parent already has its root, and appending a second one would
// report a fabricated ancestor beneath a commit the caller created with
// `parents: []` precisely to say it has none.
export async function commitList(
  db: C,
  tenant: string,
  repo: RepoRow,
  branch: string,
): Promise<CommitRow[]> {
  const head = await headOf(db, tenant, repo, branch)
  const walked = head === '' ? [] : chainFrom(head, await commitsBySha(db, tenant, repo))
  const last = walked[walked.length - 1]
  if (last !== undefined && last.parentSha === '') return walked
  const tree = await treeOfBranch(db, tenant, repo, branch)
  const pairs: Array<[string, string]> = [...tree.entries()].map(([p, d]) => [p, blobSha(d)])
  return [...walked, rootCommit(pairs)]
}

export function directoriesOf(files: Tree): Set<string> {
  const dirs = new Set<string>()
  for (const path of files.keys()) {
    const parts = path.split('/').slice(0, -1)
    for (let i = 1; i <= parts.length; i += 1) dirs.add(parts.slice(0, i).join('/'))
  }
  return dirs
}

export async function submodulesOf(db: C, tenant: string, repo: RepoRow): Promise<string[]> {
  const rows = await db.githubSubmodule.findMany({
    where: { ...scope(tenant), repo: repo.fullName },
    orderBy: { path: 'asc' },
  })
  return rows.map((r) => r.path)
}

// Recursive tree entries, optionally rooted at a subdirectory: blobs carry a
// size, trees carry none, and a gitlink is mode 160000 with no blob behind it.
// One git tree entry. Typed rather than JsonValue because the tree route reads
// `path` back to filter a truncated listing, and a caller that has to cast for
// that is a caller the shape was never declared to.
// A blob entry carries a size and a tree or gitlink entry carries none, so the
// two are spelled as a union rather than as one shape with an optional field:
// an optional property widens to `| undefined`, which is not a JSON value, and
// the whole entry then stops being one.
export type TreeItem =
  | { path: string; mode: string; type: string; sha: string }
  | { path: string; mode: string; type: string; sha: string; size: number }

export function treeItems(files: Tree, submodules: string[], at = ''): TreeItem[] {
  const prefix = at === '' ? '' : `${at}/`
  const items: TreeItem[] = []
  for (const path of [...directoriesOf(files)].sort()) {
    if (!path.startsWith(prefix) || path === at) continue
    items.push({
      path: path.slice(prefix.length),
      mode: '040000',
      type: 'tree',
      sha: treeSha(path),
    })
  }
  for (const path of [...files.keys()].sort()) {
    if (!path.startsWith(prefix)) continue
    const data = files.get(path) ?? Buffer.alloc(0)
    items.push({
      path: path.slice(prefix.length),
      mode: '100644',
      type: 'blob',
      sha: blobSha(data),
      size: data.length,
    })
  }
  for (const path of [...submodules].sort()) {
    if (!path.startsWith(prefix)) continue
    items.push({
      path: path.slice(prefix.length),
      mode: '160000',
      type: 'commit',
      sha: commitSha(path),
    })
  }
  items.sort((a, b) => (a.path < b.path ? -1 : 1))
  return items
}

// The python fake kept a term -> paths index and rebuilt it on every write.
// Scanning the default branch per query answers the same thing for a
// fixture-sized repository without a second structure that a write can forget
// to update. The size limit is kept because it is observable: a file at or
// over it is not searchable.
const TOKEN_RE = /[A-Za-z0-9_]+/g

export function searchTree(files: Tree, terms: string[], pathFilter: string | null): string[] {
  if (terms.length === 0) return []
  // Every term must hit, so the result is the intersection: seed it with the
  // first term's hits and narrow with each of the rest.
  let matched = new Set<string>()
  let first = true
  for (const term of terms) {
    const hits = new Set<string>()
    for (const [path, data] of files) {
      if (data.length >= SEARCH_SIZE_LIMIT) continue
      const text = data.toString('utf8').toLowerCase()
      const tokens = text.match(TOKEN_RE)
      if (tokens !== null && tokens.includes(term)) hits.add(path)
    }
    if (first) {
      matched = hits
      first = false
    } else {
      const kept = new Set<string>()
      for (const path of matched) if (hits.has(path)) kept.add(path)
      matched = kept
    }
    if (matched.size === 0) return []
  }
  let found = [...matched].sort()
  if (pathFilter !== null && pathFilter !== '') {
    const at = pathFilter.replace(/^\/+|\/+$/g, '')
    found = found.filter((p) => p === at || p.startsWith(`${at}/`))
  }
  return found
}
