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
import { deleteOrder, stripSlash, tenantWhere } from '../kit/typescript/index.ts'
import type { Dmmf, JsonValue } from '../kit/typescript/index.ts'
import { DEFAULT_LOGIN, REPO_DATE, SEARCH_SIZE_LIMIT, config } from './config.ts'
import type { C } from './config.ts'
import { languagesOf } from './languages.ts'
import {
  blobSha,
  commitIdentity,
  commitJson,
  commitSha,
  parentsOf,
  rootCommit,
  rootSha,
  treeSha,
} from './wire.ts'
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
  pagesJson: string
  seq: number
}

export type Tree = Map<string, Buffer>

// A tree's gitlinks: each path and the commit it names.
export type Links = Map<string, string>

// A tree as a listing reads it: its blobs and its gitlinks. A submodule is a
// path in a tree, so the links belong to the tree and not to its repository.
export interface Snapshot {
  files: Tree
  links: Links
}

const BLOB_MODE = '100644'
const LINK_MODE = '160000'

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

// One typed handle onto a delegate named at runtime. The two lifecycle walks are
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

// The logins a fixture states for a repository's `stargazers` or
// `subscribers`, in its order.
export function loginsOf(repo: RepoRow, key: string): string[] {
  const value = metaOf(repo)[key]
  return Array.isArray(value) ? value.map(String) : []
}

// Its star count: the one its fixture states, or else how many it lists.
export function starsOf(repo: RepoRow): number {
  const stated = metaOf(repo).stargazers_count
  return typeof stated === 'number' ? stated : loginsOf(repo, 'stargazers').length
}

// A repository's languages, largest first: the ones its fixture states, as
// GitHub's `{name: bytes}`, or else what Linguist counts in its default
// branch.
export async function repoLanguages(
  db: C,
  tenant: string,
  repo: RepoRow,
): Promise<Array<[string, number]>> {
  const stated = metaOf(repo).languages
  if (typeof stated === 'object' && stated !== null && !Array.isArray(stated)) {
    return Object.entries(stated)
      .flatMap(([name, size]): Array<[string, number]> =>
        typeof size === 'number' ? [[name, size]] : [],
      )
      .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1))
  }
  return languagesOf(await treeOfBranch(db, tenant, repo, repo.defaultBranch))
}

// Its primary language: the one its fixture states, null included, or else
// its largest.
export async function primaryLanguage(
  db: C,
  tenant: string,
  repo: RepoRow,
): Promise<string | null> {
  const meta = metaOf(repo)
  if ('language' in meta) return typeof meta.language === 'string' ? meta.language : null
  return (await repoLanguages(db, tenant, repo))[0]?.[0] ?? null
}

// The repository shape every route returns. A fixture's own values win, except
// default_branch, which seeding decides, and the lists it states, which are
// read through their own endpoints.
export async function repoJson(db: C, tenant: string, repo: RepoRow): Promise<JsonValue> {
  const meta = metaOf(repo)
  const {
    default_branch: _ignored,
    parent_seq: _parent,
    languages: _languages,
    stargazers: _stargazers,
    subscribers: _subscribers,
    ...rest
  } = meta
  return {
    name: repo.name,
    full_name: repo.fullName,
    default_branch: repo.defaultBranch,
    owner: { login: repo.owner },
    html_url: `https://github.com/${repo.fullName}`,
    description: null,
    stargazers_count: starsOf(repo),
    watchers_count: starsOf(repo),
    subscribers_count: loginsOf(repo, 'subscribers').length,
    forks_count: 0,
    open_issues_count: 0,
    language: await primaryLanguage(db, tenant, repo),
    topics: [],
    archived: false,
    fork: false,
    has_pages: repo.pagesJson !== '',
    ...rest,
  }
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

// A tree's content, as `path:blob` and `path@commit` rows in path order. This
// is the tree's whole identity, so it is what both the sha and any equality
// test are derived from.
export function treeFingerprint(files: Tree, links: Links = new Map()): string {
  return fingerprintOf([
    ...[...files].map(([p, d]): [string, string] => [p, `${p}:${blobSha(d)}`]),
    ...[...links].map(([p, c]): [string, string] => [p, `${p}@${c}`]),
  ])
}

function fingerprintOf(rows: Array<[string, string]>): string {
  return rows
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, row]) => row)
    .join('\0')
}

// The repositories whose objects one repository can read: itself and every
// fork in its network, the one its forks descend from included, as GitHub
// shares one object store across a fork network. A repository no fork touches
// is a network of one.
export async function networkNames(db: C, tenant: string, repo: RepoRow): Promise<string[]> {
  const repos = await allRepos(db, tenant)
  const bySeq = new Map(repos.map((row) => [row.seq, row]))
  const rootOf = (row: RepoRow): number => {
    const seen = new Set<number>()
    let at = row
    for (;;) {
      const parent = metaOf(at).parent_seq
      const up = typeof parent === 'number' ? bySeq.get(parent) : undefined
      if (up === undefined || seen.has(up.seq)) return at.seq
      seen.add(at.seq)
      at = up
    }
  }
  const root = rootOf(repo)
  const names = repos.filter((row) => rootOf(row) === root).map((row) => row.fullName)
  return [repo.fullName, ...names.filter((name) => name !== repo.fullName)]
}

// The repository of this one's network an account owns that a head of
// `owner:branch` names: this repository when it is that account's, else the
// account's fork that holds the branch, since the fake lets one account keep
// several forks of a network where GitHub keeps one.
export async function forkOwnedBy(
  db: C,
  tenant: string,
  repo: RepoRow,
  owner: string,
  branch: string,
): Promise<RepoRow | null> {
  const network = await networkNames(db, tenant, repo)
  const repos = await allRepos(db, tenant)
  const owned = repos.filter(
    (r) => network.includes(r.fullName) && r.owner.toLowerCase() === owner.toLowerCase(),
  )
  const self = owned.find((r) => r.seq === repo.seq)
  if (self !== undefined) return self
  for (const candidate of owned) {
    if ((await branchFor(db, tenant, candidate, branch)) !== null) return candidate
  }
  return owned[0] ?? null
}

// Objects are scoped to a fork network even when an unrelated repository
// holds identical content and therefore the same sha.
// `mode` narrows the read to blobs or to gitlinks, for a caller that needs
// only one of them.
export async function stagedSnapshot(
  db: C,
  tenant: string,
  repo: RepoRow,
  sha: string,
  mode: string | null = null,
): Promise<Snapshot | null> {
  const tree = await db.githubStagedTree.findFirst({
    where: { tenant, repo: { in: await networkNames(db, tenant, repo) }, sha },
  })
  if (tree === null) return null
  return await storedSnapshot(db, tenant, tree.repo, sha, mode)
}

async function storedSnapshot(
  db: C,
  tenant: string,
  repo: string,
  sha: string,
  mode: string | null = null,
): Promise<Snapshot> {
  const rows = await db.githubStagedEntry.findMany({
    where: { tenant, repo, treeSha: sha, ...(mode === null ? {} : { mode }) },
    orderBy: { seq: 'asc' },
  })
  const out: Snapshot = { files: new Map(), links: new Map() }
  for (const r of rows) {
    if (r.mode === LINK_MODE) out.links.set(r.path, r.sha)
    else out.files.set(r.path, Buffer.from(r.data))
  }
  return out
}

export async function stagedTree(
  db: C,
  tenant: string,
  repo: RepoRow,
  sha: string,
): Promise<Tree | null> {
  return (await stagedSnapshot(db, tenant, repo, sha))?.files ?? null
}

// The gitlinks a fixture seeds, which a branch carries while nothing has
// moved it.
export async function rootLinks(db: C, tenant: string, repo: RepoRow): Promise<Links> {
  return new Map((await submodulesOf(db, tenant, repo)).map((path) => [path, commitSha(path)]))
}

// The gitlinks a branch's tree holds: its head commit's, which every write
// carries forward, or the seeded ones while the branch is still on its
// synthesized root.
export async function branchLinks(
  db: C,
  tenant: string,
  repo: RepoRow,
  branch: string,
): Promise<Links> {
  const head = await headOf(db, tenant, repo, branch)
  const commit =
    head === ''
      ? null
      : await db.githubCommit.findFirst({
          where: {
            ...scope(tenant),
            repo: { in: await networkNames(db, tenant, repo) },
            sha: head,
          },
          select: { treeSha: true },
        })
  const staged =
    commit === null || commit.treeSha === ''
      ? null
      : await stagedSnapshot(db, tenant, repo, commit.treeSha, LINK_MODE)
  return staged?.links ?? (await rootLinks(db, tenant, repo))
}

// A blob by its sha, from any tree the repository has held: each branch's
// files, then every staged tree, which holds each commit's snapshot and each
// tree a write replaced. Git keeps an object once it is written, so a sha an
// old listing named still reads its own bytes after the path changes, and a
// new tree entry can still name it. Measured against GitHub (2026-09-27): a
// superseded blob answers 200 with its old bytes.
export async function blobBySha(
  db: C,
  tenant: string,
  repo: RepoRow,
  sha: string,
): Promise<Buffer | null> {
  for (const branch of await branchNames(db, tenant, repo)) {
    const files = await treeOfBranch(db, tenant, repo, branch)
    for (const data of files.values()) if (blobSha(data) === sha) return data
  }
  const network = await networkNames(db, tenant, repo)
  const row =
    (await db.githubStagedEntry.findFirst({
      where: { tenant, repo: { in: network }, sha, mode: BLOB_MODE },
      select: { data: true },
    })) ??
    (await db.githubBlob.findFirst({
      where: { tenant, repo: { in: network }, sha },
      select: { data: true },
    }))
  return row === null ? null : Buffer.from(row.data)
}

// Store a blob `POST git/blobs` wrote, which no tree holds until an entry
// names it, and answer its sha. A blob is its bytes, so bytes the network
// can already read are not stored twice.
export async function storeBlob(
  db: C,
  tenant: string,
  repo: RepoRow,
  data: Buffer,
): Promise<string> {
  const sha = blobSha(data)
  if ((await blobBySha(db, tenant, repo, sha)) !== null) return sha
  const count = await db.githubBlob.count({ where: { tenant, repo: repo.fullName } })
  await db.githubBlob.create({
    data: { tenant, repo: repo.fullName, sha, data: new Uint8Array(data), seq: count },
  })
  return sha
}

// Stage the tree a write is about to replace, so the bytes it drops stay
// readable by sha. Staging is content-addressed, so a tree a commit already
// staged costs one lookup, and only a seeded tree, which no commit staged, is
// ever copied.
export async function keepTree(
  db: C,
  tenant: string,
  repo: RepoRow,
  branch: string,
): Promise<void> {
  const files = await treeOfBranch(db, tenant, repo, branch)
  if (files.size > 0) {
    await stageTree(db, tenant, repo, files, await branchLinks(db, tenant, repo, branch))
  }
}

// A branch still on its synthesized root is about to move off it, so the
// root is stored as a commit: git keeps an object once it exists, and a sha
// a listing reported must still resolve once no branch stands on it. It is
// stored with no tree, as the synthesized one has none; its files are the
// snapshot staged here, which `treeAt` finds by content.
export async function keepRoot(
  db: C,
  tenant: string,
  repo: RepoRow,
  branch: string,
): Promise<void> {
  if ((await headOf(db, tenant, repo, branch)) !== '') return
  const files = await treeOfBranch(db, tenant, repo, branch)
  if (files.size === 0) return
  await stageTree(db, tenant, repo, files, await rootLinks(db, tenant, repo))
  const root = rootCommit(rootOf(files))
  const where = { ...scope(tenant), repo: repo.fullName }
  if ((await db.githubCommit.findFirst({ where: { ...where, sha: root.sha } })) !== null) return
  const top = await db.githubCommit.findFirst({ where, orderBy: { seq: 'desc' } })
  await db.githubCommit.create({
    data: {
      tenant,
      repo: repo.fullName,
      sha: root.sha,
      parentSha: '',
      message: root.message,
      authorLogin: root.authorLogin,
      date: root.date,
      treeSha: '',
      authorJson: '',
      committerJson: '',
      seq: top === null ? 0 : top.seq + 1,
    },
  })
}

// The id a whole tree has, staged or not: the one `stageTree` stores it
// under, so a seeded branch's tree and the snapshot a write later keeps of it
// are one object. Content alone decides it, as in git, so a rename keeps every
// id and a fork reads the ids its source reported.
export function treeIdOf(files: Tree, links: Links): string {
  return treeSha(treeFingerprint(files, links))
}

// One directory of a tree as a tree of its own, paths relative to it. Always
// fresh maps, so a caller may edit what it gets.
export function subtreeOf(tree: Snapshot, at: string): Snapshot {
  const prefix = at === '' ? '' : `${at}/`
  const cut = <T>(from: Map<string, T>): Map<string, T> =>
    new Map(
      [...from]
        .filter(([path]) => path.startsWith(prefix))
        .map(([path, value]): [string, T] => [path.slice(prefix.length), value]),
    )
  return { files: cut(tree.files), links: cut(tree.links) }
}

// Every directory's tree id, the root's under '', each the id its content
// would have as a whole tree. Content decides it as it does in git, so a
// directory that changed has a new id and an older listing's id still names
// what that directory held then. One pass: each blob and gitlink joins every
// directory above it.
export function directoryIds(files: Tree, links: Links): Map<string, string> {
  const rows = new Map<string, Array<[string, string]>>([['', []]])
  const add = (path: string, row: (rel: string) => string): void => {
    const parts = path.split('/')
    for (let depth = 0; depth < parts.length; depth += 1) {
      const dir = parts.slice(0, depth).join('/')
      const rel = parts.slice(depth).join('/')
      const list = rows.get(dir) ?? []
      list.push([rel, row(rel)])
      rows.set(dir, list)
    }
  }
  for (const [path, data] of files) {
    const blob = blobSha(data)
    add(path, (rel) => `${rel}:${blob}`)
  }
  for (const [path, commit] of links) add(path, (rel) => `${rel}@${commit}`)
  return new Map([...rows].map(([dir, list]) => [dir, treeSha(fingerprintOf(list))]))
}

// Where a tree id names a tree: the tree that holds it and the directory of it
// the id names, '' for a whole tree.
export interface TreeAtId extends Snapshot {
  at: string
}

// Snapshots index every directory, the root included, so a historical lookup
// loads only the matching tree. Seeded branches have no snapshot until a
// write preserves them and are the only trees that still need hashing here.
export async function treeById(
  db: C,
  tenant: string,
  repo: RepoRow,
  sha: string,
): Promise<TreeAtId | null> {
  const dir = await db.githubStagedDir.findFirst({
    where: { tenant, repo: { in: await networkNames(db, tenant, repo) }, sha },
  })
  if (dir !== null) {
    return { ...(await storedSnapshot(db, tenant, dir.repo, dir.treeSha)), at: dir.path }
  }
  for (const branch of await branchNames(db, tenant, repo)) {
    const files = await treeOfBranch(db, tenant, repo, branch)
    if (files.size === 0) continue
    const links = await branchLinks(db, tenant, repo, branch)
    for (const [at, id] of directoryIds(files, links)) if (id === sha) return { files, links, at }
  }
  return null
}

// The tree a commit names, as every commit rendering reports it: the one it
// was written with, or for a synthesized root the id of the files it holds.
export async function commitTreeId(
  db: C,
  tenant: string,
  repo: RepoRow,
  commit: CommitRow,
): Promise<string> {
  if (commit.treeSha !== '') return commit.treeSha
  return treeIdOf(await commitTree(db, tenant, repo, commit), await rootLinks(db, tenant, repo))
}

// Commits as the REST endpoints list them, each naming its tree.
export async function commitsJson(
  db: C,
  tenant: string,
  repo: RepoRow,
  rows: CommitRow[],
): Promise<JsonValue[]> {
  const out: JsonValue[] = []
  for (const row of rows) {
    out.push(commitJson(repo.fullName, row, await commitTreeId(db, tenant, repo, row)))
  }
  return out
}

// Store one tree, gitlinks included, and answer its sha. The sha is the
// content's, the way git's is, so staging the same tree twice is one object,
// once per fork network since a network shares its objects, and no id can be
// reproduced by a later tree landing in a slot a delete freed. Each directory
// is indexed under its own id as it is staged.
export async function stageTree(
  db: C,
  tenant: string,
  repo: RepoRow,
  files: Tree,
  links: Links,
): Promise<string> {
  const sha = treeIdOf(files, links)
  const already = await db.githubStagedTree.findFirst({
    where: { tenant, repo: { in: await networkNames(db, tenant, repo) }, sha },
  })
  if (already !== null) return sha
  const count = await db.githubStagedTree.count({ where: { tenant, repo: repo.fullName } })
  await db.githubStagedTree.create({
    data: {
      tenant,
      repo: repo.fullName,
      sha,
      seq: count,
      entries: {
        create: [
          ...[...files].map(([path, data], seq) => ({
            path,
            data: new Uint8Array(data),
            sha: blobSha(data),
            mode: BLOB_MODE,
            seq,
          })),
          ...[...links].map(([path, commit], seq) => ({
            path,
            data: new Uint8Array(0),
            sha: commit,
            mode: LINK_MODE,
            seq: files.size + seq,
          })),
        ],
      },
      dirs: {
        create: [...directoryIds(files, links)].map(([path, id]) => ({ path, sha: id })),
      },
    },
  })
  return sha
}

// A branch by name: bare, HEAD, the empty string, or fully qualified. Tool
// schemas advertise `refs/heads/main` and the live API accepts it on every
// ref-taking parameter. Only a name, never a sha, because a write names the
// branch it lands on; a read resolves a sha through `resolveRef`.
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
  return branches.includes(name) ? name : null
}

// Git's shortest abbreviation, and GitHub's. Measured against GitHub
// (2026-09-29): four hex digits name a commit in `/commits/{ref}`, `?sha=` and
// `?ref=`, in either case, and three name nothing.
const ABBREVIATED_SHA = /^[0-9a-f]{4,40}$/i

// What a ref names. `branch` is set when it names a branch and null when it
// names a tag or one commit by its sha. Its history is newest first, which
// `commits?sha=` lists and whose head `commits/{ref}` answers.
export interface Resolved {
  branch: string | null
  history: CommitRow[]
}

export interface TagRow {
  sha: string
  tag: string
  message: string
  objectSha: string
  objectType: string
  taggerJson: string
}

export interface TagRefRow {
  name: string
  sha: string
}

// An annotated tag object by its sha, from anywhere in the repository's
// network, since a tag object is a git object like any other: a fork's copy
// of a tag ref still peels through the one its source made.
export async function tagObject(
  db: C,
  tenant: string,
  repo: RepoRow,
  sha: string,
): Promise<TagRow | null> {
  return (await db.githubTag.findFirst({
    where: { tenant, repo: { in: await networkNames(db, tenant, repo) }, sha },
  })) as TagRow | null
}

export async function tagRefs(db: C, tenant: string, repo: RepoRow): Promise<TagRefRow[]> {
  return (await db.githubTagRef.findMany({
    where: { tenant, repo: repo.fullName },
    orderBy: { name: 'asc' },
  })) as TagRefRow[]
}

// The commit a tag names, through any tag objects between.
export async function peeled(db: C, tenant: string, repo: RepoRow, sha: string): Promise<string> {
  const seen = new Set<string>()
  let at = sha
  for (let tag = await tagObject(db, tenant, repo, at); tag !== null && !seen.has(at);) {
    seen.add(at)
    at = tag.objectSha
    tag = await tagObject(db, tenant, repo, at)
  }
  return at
}

// Resolve only commit identities, including dangling commits and synthesized
// roots. A prefix two commits share names neither; ref names cannot redirect it.
async function resolveCommit(
  db: C,
  tenant: string,
  repo: RepoRow,
  ref: string,
): Promise<Resolved | null> {
  if (!ABBREVIATED_SHA.test(ref)) return null
  const want = ref.toLowerCase()
  const found = new Set<string>()
  const stored = await db.githubCommit.findMany({
    where: {
      ...scope(tenant),
      repo: { in: await networkNames(db, tenant, repo) },
      sha: { startsWith: want },
    },
    select: { sha: true },
  })
  for (const row of stored) found.add(row.sha)
  for (const name of await branchNames(db, tenant, repo)) {
    const root = (await commitList(db, tenant, repo, name)).at(-1)
    if (root !== undefined && root.sha.startsWith(want)) found.add(root.sha)
  }
  const [sha] = [...found]
  if (found.size !== 1 || sha === undefined) return null
  return { branch: null, history: historyFrom(sha, await commitsBySha(db, tenant, repo)) }
}

async function resolveTag(
  db: C,
  tenant: string,
  repo: RepoRow,
  name: string,
): Promise<Resolved | null> {
  const tag = await db.githubTagRef.findFirst({
    where: { tenant, repo: repo.fullName, name },
  })
  if (tag === null) return null
  const sha = await peeled(db, tenant, repo, tag.sha)
  return { branch: null, history: historyFrom(sha, await commitsBySha(db, tenant, repo)) }
}

// One step of git's ancestry suffix: `^{}` or `^{commit}` peels to the commit,
// `^<n>` names its nth parent and `~<n>` its nth first-parent ancestor, a bare
// `^` or `~` meaning 1.
const ANCESTRY_STEP = /^(?:\^\{(?:commit)?\}|\^(\d*)|~(\d*))/

// The commit a suffix walks to from `from`, or null for one that names no
// commit: `^<n>` past a commit's last parent, or `~<n>` past the start of its
// first-parent chain. `^0` is the commit itself.
function ancestorOf(
  from: CommitRow,
  suffix: string,
  byId: Map<string, CommitRow>,
): CommitRow | null {
  let at = from
  let rest = suffix
  while (rest !== '') {
    const step = ANCESTRY_STEP.exec(rest)
    if (step === null) return null
    rest = rest.slice(step[0].length)
    const [, parent, back] = step
    if (parent !== undefined) {
      const n = parent === '' ? 1 : Number(parent)
      if (n === 0) continue
      const sha = parentsOf(at)[n - 1]
      if (sha === undefined) return null
      at = byId.get(sha) ?? rootCommit(sha)
    } else if (back !== undefined) {
      for (let n = back === '' ? 1 : Number(back); n > 0; n--) {
        if (at.parentSha === '') return null
        at = byId.get(at.parentSha) ?? rootCommit(at.parentSha)
      }
    }
  }
  return at
}

// A fully qualified name stays in its namespace. Otherwise an existing full
// commit sha wins, followed by a branch, a tag, then an unambiguous
// abbreviated sha. A name under `tags/` reads in git's order: the tag it
// names, then a tag or a branch spelled that way whole, so a branch called
// `tags/release` is still found by that name.
//
// Any of them takes git's ancestry suffix, `main~2` or `<sha>^`: a ref name
// cannot hold `^` or `~`, so the first one starts it. What it names is a
// commit, never the branch it was walked from.
export async function resolveRef(
  db: C,
  tenant: string,
  repo: RepoRow,
  ref: string | null,
): Promise<Resolved | null> {
  const cut = ref === null ? -1 : ref.search(/[~^]/)
  if (ref !== null && cut >= 0) {
    const from = cut === 0 ? null : await resolveRef(db, tenant, repo, ref.slice(0, cut))
    const start = from?.history[0]
    if (start === undefined) return null
    const byId = await commitsBySha(db, tenant, repo)
    const at = ancestorOf(start, ref.slice(cut), byId)
    return at === null ? null : { branch: null, history: historyFrom(at.sha, byId) }
  }
  if (ref !== null && ref.startsWith('refs/tags/')) {
    return await resolveTag(db, tenant, repo, ref.slice('refs/tags/'.length))
  }
  if (ref !== null && ref.startsWith('tags/')) {
    const tagged =
      (await resolveTag(db, tenant, repo, ref.slice('tags/'.length))) ??
      (await resolveTag(db, tenant, repo, ref))
    if (tagged !== null) return tagged
    const whole = await branchFor(db, tenant, repo, ref)
    return whole === null
      ? null
      : { branch: whole, history: await commitList(db, tenant, repo, whole) }
  }
  if (ref?.length === 40) {
    const commit = await resolveCommit(db, tenant, repo, ref)
    if (commit !== null) return commit
  }
  const branch = await branchFor(db, tenant, repo, ref)
  if (branch !== null) return { branch, history: await commitList(db, tenant, repo, branch) }
  if (ref === null || /^(?:refs\/)?heads\//.test(ref)) return null
  return (await resolveTag(db, tenant, repo, ref)) ?? (await resolveCommit(db, tenant, repo, ref))
}

// The files a resolved ref names: a branch's as they are now, a commit's as
// that commit recorded them. Reading the branch that holds a commit instead
// answered an older sha with whatever the branch had gained since.
export async function treeAt(
  db: C,
  tenant: string,
  repo: RepoRow,
  at: Resolved,
): Promise<Tree | null> {
  if (at.branch !== null) return await treeOfBranch(db, tenant, repo, at.branch)
  const commit = at.history[0]
  if (commit === undefined) return null
  if (commit.treeSha !== '') return await stagedTree(db, tenant, repo, commit.treeSha)
  return await rootTree(db, tenant, repo, commit.sha)
}

export async function treeOf(
  db: C,
  tenant: string,
  repo: RepoRow,
  ref: string | null,
): Promise<Tree | null> {
  const at = await resolveRef(db, tenant, repo, ref)
  return at === null ? null : await treeAt(db, tenant, repo, at)
}

// The tree a resolved ref names with its gitlinks, as a listing reads it.
export async function snapshotAt(
  db: C,
  tenant: string,
  repo: RepoRow,
  at: Resolved,
): Promise<Snapshot | null> {
  if (at.branch !== null) {
    return {
      files: await treeOfBranch(db, tenant, repo, at.branch),
      links: await branchLinks(db, tenant, repo, at.branch),
    }
  }
  const commit = at.history[0]
  if (commit === undefined) return null
  if (commit.treeSha !== '') return await stagedSnapshot(db, tenant, repo, commit.treeSha)
  const files = await rootTree(db, tenant, repo, commit.sha)
  return files === null ? null : { files, links: await rootLinks(db, tenant, repo) }
}

export async function snapshotOf(
  db: C,
  tenant: string,
  repo: RepoRow,
  ref: string | null,
): Promise<Snapshot | null> {
  const at = await resolveRef(db, tenant, repo, ref)
  return at === null ? null : await snapshotAt(db, tenant, repo, at)
}

// The sha a tree's synthesized root takes, derived from its content so that a
// mirror of a repository has the same root as its source.
export function rootOf(tree: Tree): string {
  return rootSha([...tree.entries()].map(([p, d]): [string, string] => [p, blobSha(d)]))
}

// A synthesized root stores no tree, so its files are found by content: a
// branch still carrying them, or the snapshot the first write kept.
async function rootTree(db: C, tenant: string, repo: RepoRow, sha: string): Promise<Tree | null> {
  for (const branch of await branchNames(db, tenant, repo)) {
    const files = await treeOfBranch(db, tenant, repo, branch)
    if (files.size > 0 && rootOf(files) === sha) return files
  }
  const staged = await db.githubStagedTree.findMany({
    where: { tenant, repo: { in: await networkNames(db, tenant, repo) } },
    orderBy: { seq: 'asc' },
    select: { sha: true },
  })
  for (const row of staged) {
    const files = await stagedTree(db, tenant, repo, row.sha)
    if (files !== null && files.size > 0 && rootOf(files) === sha) return files
  }
  return null
}

// Every commit a repository can read, its network's included, keyed by sha,
// for walking a chain without a query per hop.
export async function commitsBySha(
  db: C,
  tenant: string,
  repo: RepoRow,
): Promise<Map<string, CommitRow>> {
  const rows = (await db.githubCommit.findMany({
    where: { ...scope(tenant), repo: { in: await networkNames(db, tenant, repo) } },
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

// Whether `ancestor` is reachable from `head` through any parent, which is
// the exact question a fast-forward asks: a branch merged into another is
// behind it, not beside it. The empty sha is every commit's ancestor, since
// that is where a chain ends.
export function reaches(head: string, ancestor: string, byId: Map<string, CommitRow>): boolean {
  if (ancestor === '') return true
  // Walked as POINTERS rather than as rows, because the sha being looked for
  // may be one no row carries: a synthesized root is derived from a branch's
  // content and stored nowhere, yet it is what the ref endpoint answers with
  // and therefore what a commit on a seeded branch states as its parent.
  const seen = new Set<string>()
  const pending = [head]
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    if (at === ancestor) return true
    if (at === '' || seen.has(at)) continue
    seen.add(at)
    const row = byId.get(at)
    if (row !== undefined) pending.push(...parentsOf(row))
  }
  return false
}

// Every commit reachable from a sha through any parent, newest first, as
// GitHub lists a ref's commits: git's default walk, which lists the commit
// with the latest commit date among the ones reached and not yet listed, ties
// going to the one reached first. The sha itself always comes first. A parent
// no row holds is a synthesized root, listed with no parents of its own.
export function reachableFrom(head: string, byId: Map<string, CommitRow>): CommitRow[] {
  const out: CommitRow[] = []
  const seen = new Set([head])
  const queue = [byId.get(head) ?? rootCommit(head)]
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    out.push(next)
    for (const sha of parentsOf(next)) {
      if (seen.has(sha)) continue
      seen.add(sha)
      const row = byId.get(sha) ?? rootCommit(sha)
      const when = committedAt(row)
      const at = queue.findIndex((other) => when > committedAt(other))
      queue.splice(at === -1 ? queue.length : at, 0, row)
    }
  }
  return out
}

function committedAt(row: CommitRow): number {
  return Date.parse(commitIdentity(row).committed)
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
  return tree.size === 0 ? '' : rootOf(tree)
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

// A repository is empty until some branch points somewhere. That belongs to
// the repository, not to the ref a caller names, and the vendor answers it
// before resolving that ref: in an empty repository a ref that matches nothing
// is told the repository is empty, not that the ref is missing, so the test
// cannot wait for a ref to resolve to a branch.
export async function repoIsEmpty(db: C, tenant: string, repo: RepoRow): Promise<boolean> {
  for (const branch of await branchNames(db, tenant, repo)) {
    if ((await visibleHeadOf(db, tenant, repo, branch)) !== '') return false
  }
  return true
}

// One branch's commits, newest first: the chain its ref points at, and under
// it the synthetic root that chain was built on. A branch nothing has been
// committed to derives its root from its CONTENT rather than the repository's
// name, so that a mirror of a repository has the same root sha as its source,
// and two such branches differ in that root exactly when their trees differ.
// The chain is walked rather than filtered by a column, so a commit two refs
// share is on both lists and a commit a reset abandoned is on neither, without
// either case being written down anywhere.
//
// Once a commit stands on that root, the root is the parent that commit names.
// Deriving it again from the files would move it with every write, to a sha
// the ref never reported, and the oldest commit's parent would be missing from
// the very history that lists the commit.
//
// That synthetic root is the floor for a chain that does not reach one of its
// own, not a parent stapled under every history. A chain ENDING at a stored
// commit with no parent already has its root, and appending a second one would
// report a fabricated ancestor beneath a commit the caller created with
// `parents: []` precisely to say it has none. A branch with neither a commit
// nor a file has no root at all, which is how an empty repository reads.
export async function commitList(
  db: C,
  tenant: string,
  repo: RepoRow,
  branch: string,
): Promise<CommitRow[]> {
  const head = await headOf(db, tenant, repo, branch)
  if (head !== '') return historyFrom(head, await commitsBySha(db, tenant, repo))
  const tree = await treeOfBranch(db, tenant, repo, branch)
  return tree.size === 0 ? [] : [rootCommit(rootOf(tree))]
}

// Every commit a branch holds, reached through any parent, newest first, as
// reachableFrom lists them: what its commit listing, its contributors and a
// search of it read, where commitList is the first-parent chain a ref's
// history and its `~<n>` walk.
export async function branchCommits(
  db: C,
  tenant: string,
  repo: RepoRow,
  branch: string,
): Promise<CommitRow[]> {
  const head = await headOf(db, tenant, repo, branch)
  if (head === '') return await commitList(db, tenant, repo, branch)
  return reachableFrom(head, await commitsBySha(db, tenant, repo))
}

// A commit's history, newest first: the first-parent chain from it and the
// synthesized root under that chain, or the root alone when the sha is one.
export function historyFrom(head: string, byId: Map<string, CommitRow>): CommitRow[] {
  const walked = chainFrom(head, byId)
  const last = walked.at(-1)
  if (last === undefined) return [rootCommit(head)]
  return last.parentSha === '' ? walked : [...walked, rootCommit(last.parentSha)]
}

// The files one commit recorded, or none for a commit that recorded nothing
// the fake can still find.
export async function commitTree(
  db: C,
  tenant: string,
  repo: RepoRow,
  commit: CommitRow,
): Promise<Tree> {
  return (await treeAt(db, tenant, repo, { branch: null, history: [commit] })) ?? new Map()
}

// Where two histories meet: the head's commits the base cannot reach, newest
// first, how many of the base's the head cannot reach, and the newest commit
// both reach. Null when they never meet, which is a different answer from
// meeting at the head.
export interface Divergence {
  ahead: CommitRow[]
  behind: number
  mergeBase: CommitRow
}

// Both sides are every commit reachable through any parent, as reachableFrom
// lists them, so a branch merged into the base reads as behind it, or as
// identical, never as diverged from it. The merge base is a commit both reach
// that no other such commit reaches, as git's is: dates alone can list an
// older shared ancestor first, and commits made in one second all tie.
export function divergence(head: CommitRow[], base: CommitRow[]): Divergence | null {
  const onBase = new Set(base.map((c) => c.sha))
  const onHead = new Set(head.map((c) => c.sha))
  const shared = head.filter((c) => onBase.has(c.sha))
  const byId = new Map(head.map((c) => [c.sha, c]))
  const below = new Set<string>()
  const pending = shared.flatMap(parentsOf)
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    if (below.has(at)) continue
    below.add(at)
    const row = byId.get(at)
    if (row !== undefined) pending.push(...parentsOf(row))
  }
  const mergeBase = shared.find((c) => !below.has(c.sha))
  if (mergeBase === undefined) return null
  return {
    ahead: head.filter((c) => !onBase.has(c.sha)),
    behind: base.filter((c) => !onHead.has(c.sha)).length,
    mergeBase,
  }
}

export interface AccountRow {
  login: string
  type: string
  name: string
  email: string
  bio: string
  company: string
  blog: string
  location: string
  twitterUsername: string
  hireable: boolean
  followers: number
  following: number
  publicGists: number
  createdAt: string
  updatedAt: string
}

// Every account the tenant knows: each one a fixture states, the
// authenticated user, and each repository owner no fixture states, which is
// an organization unless it is that user, the way the fake has always typed
// an owner. A login none of these name is no account.
// A login as an account: the tenant's, or a user nothing states, for a login
// a fixture names in a list but gives no profile.
export async function accountOf(db: C, tenant: string, login: string): Promise<AccountRow> {
  const known = (await accountsOf(db, tenant)).find(
    (account) => account.login.toLowerCase() === login.toLowerCase(),
  )
  return known ?? { ...unstated(login), type: 'User' }
}

function unstated(login: string): AccountRow {
  const user = login === DEFAULT_LOGIN
  return {
    login,
    type: user ? 'User' : 'Organization',
    name: user ? login : '',
    email: '',
    bio: '',
    company: '',
    blog: '',
    location: '',
    twitterUsername: '',
    hireable: false,
    followers: 0,
    following: 0,
    publicGists: 0,
    createdAt: REPO_DATE,
    updatedAt: '',
  }
}

export async function accountsOf(db: C, tenant: string): Promise<AccountRow[]> {
  const stated = (await db.githubAccount.findMany({
    where: scope(tenant),
    orderBy: { seq: 'asc' },
  })) as AccountRow[]
  const out = new Map(stated.map((row) => [row.login.toLowerCase(), row]))
  const implied = [DEFAULT_LOGIN, ...(await allRepos(db, tenant)).map((repo) => repo.owner)]
  for (const login of implied) {
    if (out.has(login.toLowerCase())) continue
    out.set(login.toLowerCase(), unstated(login))
  }
  return [...out.values()]
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

export function treeItems(tree: Snapshot, at = ''): TreeItem[] {
  const { files, links } = tree
  const prefix = at === '' ? '' : `${at}/`
  const ids = directoryIds(files, links)
  const items: TreeItem[] = []
  for (const path of ids.keys()) {
    if (!path.startsWith(prefix) || path === at) continue
    items.push({
      path: path.slice(prefix.length),
      mode: '040000',
      type: 'tree',
      sha: ids.get(path) ?? '',
    })
  }
  for (const path of [...files.keys()].sort()) {
    if (!path.startsWith(prefix)) continue
    const data = files.get(path) ?? Buffer.alloc(0)
    items.push({
      path: path.slice(prefix.length),
      mode: BLOB_MODE,
      type: 'blob',
      sha: blobSha(data),
      size: data.length,
    })
  }
  for (const [path, commit] of links) {
    if (!path.startsWith(prefix)) continue
    items.push({ path: path.slice(prefix.length), mode: LINK_MODE, type: 'commit', sha: commit })
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
    const at = stripSlash(pathFilter)
    found = found.filter((p) => p === at || p.startsWith(`${at}/`))
  }
  return found
}
