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

import { createHash } from 'node:crypto'
import type { JsonValue } from '../kit/typescript/index.ts'
import { DEFAULT_LOGIN, ROOT_COMMIT_DATE, WRITE_COMMIT_DATE } from './config.ts'

// Real git object ids, so shas look plausible and stay stable across runs.
export function blobSha(data: Uint8Array): string {
  const header = Buffer.from(`blob ${String(data.length)}\0`, 'utf8')
  return createHash('sha1')
    .update(Buffer.concat([header, Buffer.from(data)]))
    .digest('hex')
}

export function treeSha(path: string): string {
  return createHash('sha1').update(`tree\0${path}`, 'utf8').digest('hex')
}

export function commitSha(path: string): string {
  return createHash('sha1').update(`commit\0${path}`, 'utf8').digest('hex')
}

/** A GraphQL global id in the vendor's base64 `<type><id>` spelling. */
export function nodeId(type: string, key: string | number): string {
  return Buffer.from(`${type}${String(key)}`).toString('base64')
}

/** The GraphQL `owner` of a repository, a user or an organization. */
export function ownerNode(login: string): Record<string, JsonValue> {
  return { id: nodeId(login === DEFAULT_LOGIN ? '04:User' : '012:Organization', login), login }
}

/**
 * A user as a GraphQL `Actor`: the concrete type rides along, since the
 * field that holds one is abstract, and the display name is the login, as
 * every user the fake knows spells it.
 */
export function userNode(login: string): Record<string, JsonValue> {
  return { __typename: 'User', id: nodeId('04:User', login), login, name: login }
}

/** The GraphQL id of an issue, keyed by its repository and number. */
export function issueNodeId(repoSeq: number, number: number): string {
  return nodeId('05:Issue', `${String(repoSeq)}:${String(number)}`)
}

/** The GraphQL id of a pull request, keyed by its repository and number. */
export function pullNodeId(repoSeq: number, number: number): string {
  return nodeId('011:PullRequest', `${String(repoSeq)}:${String(number)}`)
}

/** The eight reaction groups GraphQL lists on anything a user can react to. */
export function reactionGroups(): JsonValue[] {
  return ['THUMBS_UP', 'THUMBS_DOWN', 'LAUGH', 'HOORAY', 'CONFUSED', 'HEART', 'ROCKET', 'EYES'].map(
    (content) => ({ content, users: { totalCount: 0 } }),
  )
}

// The pull request keywords the vendor reads as "merging this closes #n".
export const CLOSING_KEYWORD = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi

/** The issue numbers a pull request body says merging it closes. */
export function closedNumbers(body: string): number[] {
  return [...body.matchAll(CLOSING_KEYWORD)].map((match) => Number(match[1]))
}

// How the vendor refuses any Projects (classic) field now.
export const PROJECTS_CLASSIC_GONE =
  'Projects (classic) is being deprecated in favor of the new Projects experience, ' +
  'see: https://github.blog/changelog/2024-05-23-sunset-notice-projects-classic/.'

/** The `first` and `after` a GraphQL connection is paged by. */
export interface PageArgs {
  first?: number | null
  after?: string | null
}

/** A GraphQL connection over rows already in hand, a page at a time. */
export function page<T>(
  rows: T[],
  first: number | null | undefined,
  after: string | null | undefined,
): {
  nodes: T[]
  totalCount: number
  pageInfo: { hasNextPage: boolean; endCursor: string | null }
} {
  const start = after ? Number(Buffer.from(after, 'base64').toString()) : 0
  const size = first ?? 100
  if (size < 0 || size > 100) throw new Error('first must be between 0 and 100')
  const nodes = rows.slice(start, start + size)
  const end = start + nodes.length
  return {
    nodes,
    totalCount: rows.length,
    pageInfo: {
      hasNextPage: end < rows.length,
      endCursor: nodes.length > 0 ? Buffer.from(String(end)).toString('base64') : null,
    },
  }
}

export function commitPerson(name: string, when: string): JsonValue {
  const handle = name.toLowerCase().replace(/ /g, '-')
  return { name, email: `${handle}@users.noreply.github.com`, date: when }
}

// The git author or committer as `POST /git/commits` takes it. This is NOT the
// `authorLogin` above turned into a person: a git identity carries whatever
// email the commit says, and its date is the caller's to state, which is the
// whole reason a fixture can pin one. Stored as posted and echoed back
// unchanged, because normalizing the offset away would silently answer a
// different instant than the one the fixture wrote down.
export interface GitPerson {
  name: string
  email: string
  date: string
}

// A supplied `author` or `committer`, or null when the caller named none, or
// INVALID_PERSON when the key is there but is not an object. That third answer
// matters: reading a malformed value as "absent" would accept the request, drop
// the identity, and answer 201, so a client's typo would look like a commit
// that simply chose not to carry a date.
export const INVALID_PERSON = 'invalid-person'

export function bodyPerson(
  body: Record<string, JsonValue>,
  key: string,
): GitPerson | null | typeof INVALID_PERSON {
  const raw = body[key]
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) return INVALID_PERSON
  const pick = (k: string, fallback: string): string => {
    const v = raw[k]
    return typeof v === 'string' && v !== '' ? v : fallback
  }
  const name = pick('name', DEFAULT_LOGIN)
  const handle = name.toLowerCase().replace(/ /g, '-')
  return {
    name,
    email: pick('email', `${handle}@users.noreply.github.com`),
    date: pick('date', WRITE_COMMIT_DATE),
  }
}

// The identity the vendor fills in when a body names no author at all: the
// authenticated user, carrying the same pinned stamp a partial person gets,
// so the answer stays deterministic.
export function defaultPerson(): GitPerson {
  return {
    name: DEFAULT_LOGIN,
    email: `${DEFAULT_LOGIN}@users.noreply.github.com`,
    date: WRITE_COMMIT_DATE,
  }
}

export function personJson(person: GitPerson | null): string {
  return person === null ? '' : JSON.stringify(person)
}

export function parsePerson(raw: string): GitPerson | null {
  if (raw === '') return null
  const parsed = JSON.parse(raw) as JsonValue
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const pick = (k: string): string => {
    const v = parsed[k]
    return typeof v === 'string' ? v : ''
  }
  return { name: pick('name'), email: pick('email'), date: pick('date') }
}

// A commit's `commit.author`/`commit.committer` pair, or null when it carries
// none. A missing committer reads as the author, and a missing author beside
// a supplied committer reads as the endpoint's default identity: both are the
// vendor's own defaults, and both keep a one-sided body from rendering half a
// commit.
export function commitPeople(row: {
  authorJson: string
  committerJson: string
}): { author: JsonValue; committer: JsonValue } | null {
  const author = parsePerson(row.authorJson)
  const committer = parsePerson(row.committerJson)
  if (author === null && committer === null) return null
  const named = author ?? defaultPerson()
  return { author: { ...named }, committer: { ...(committer ?? named) } }
}

export interface CommitRow {
  sha: string
  parentSha: string
  otherParentsJson: string
  message: string
  authorLogin: string
  date: string
  treeSha: string
  authorJson: string
  committerJson: string
  seq: number
}

// Who a commit is by and when, as its list rendering states it: a seeded
// commit's login and date, a written commit's author and committer, and for a
// commit written with neither, the authenticated user at the pinned write
// stamp, which is who the vendor would name. A git identity is an account
// only when its email is that account's noreply address.
export interface CommitIdentity {
  login: string
  name: string
  email: string
  authored: string
  committed: string
}

const NOREPLY = /^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/i

export function commitIdentity(row: CommitRow): CommitIdentity {
  if (row.authorLogin !== '') {
    const person = commitPerson(row.authorLogin, row.date) as { name: string; email: string }
    return { login: row.authorLogin, ...person, authored: row.date, committed: row.date }
  }
  const author = parsePerson(row.authorJson) ?? defaultPerson()
  const committer = parsePerson(row.committerJson) ?? author
  return {
    login: NOREPLY.exec(author.email)?.[1] ?? '',
    name: author.name,
    email: author.email,
    authored: author.date,
    committed: committer.date,
  }
}

// Every parent a commit names, in order: the first, then the ones a merge
// adds. None for a root.
export function parentsOf(row: CommitRow): string[] {
  if (row.parentSha === '') return []
  const others = JSON.parse(row.otherParentsJson) as string[]
  return [row.parentSha, ...others]
}

// A commit's parents as each rendering lists them, linked at `kind`
// (`commits` for the REST shape, `git/commits` for git's), in order, or none
// for a root.
function parentsJson(repo: string, row: CommitRow, kind: string): JsonValue[] {
  return parentsOf(row).map((sha) => ({
    sha,
    url: `https://api.github.com/repos/${repo}/${kind}/${sha}`,
    html_url: `https://github.com/${repo}/commit/${sha}`,
  }))
}

// A commit's git author and committer: a seeded commit's login at its date,
// or what a written one was given, which may be nothing.
function gitPeople(row: CommitRow): { author: JsonValue; committer: JsonValue } | null {
  if (row.authorLogin === '') return commitPeople(row)
  const person = commitPerson(row.authorLogin, row.date)
  return { author: person, committer: person }
}

function treeRef(repo: string, tree: string): JsonValue {
  return { sha: tree, url: `https://api.github.com/repos/${repo}/git/trees/${tree}` }
}

// A stored commit as `/commits`, `/commits/{ref}`, a comparison and a pull
// request list it, `tree` being the id of the tree it names. GitHub's list and
// write shapes carry no `files` key at all; serving one handed clients bare
// strings where the contract has objects, which broke history enumeration
// after the first write.
// A write records a commit carrying only a message, so its rendering omits the
// author blocks a seeded one has: the two shapes are not a default apart, and a
// golden renders the difference. An empty author is what tells them apart,
// because that is what `recordCommit` stores.
export function commitJson(repo: string, row: CommitRow, tree: string): JsonValue {
  return {
    sha: row.sha,
    commit: { message: row.message, ...(gitPeople(row) ?? {}), tree: treeRef(repo, tree) },
    ...(row.authorLogin === '' ? {} : { author: { login: row.authorLogin } }),
    parents: parentsJson(repo, row, 'commits'),
  }
}

// The same commit as git's object: what `git/commits/{sha}` reads, what
// `POST git/commits` answers, and the `commit` a contents write answers.
export function gitCommitJson(repo: string, row: CommitRow, tree: string): JsonValue {
  return {
    sha: row.sha,
    message: row.message,
    tree: treeRef(repo, tree),
    ...(gitPeople(row) ?? {}),
    parents: parentsJson(repo, row, 'git/commits'),
  }
}

export function rootSha(tree: Array<[string, string]>): string {
  const sorted = [...tree].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return commitSha(`root\0${sorted.map(([p, b]) => `${p}:${b}`).join('\0')}`)
}

export function rootCommit(sha: string): CommitRow {
  return {
    sha,
    parentSha: '',
    otherParentsJson: '[]',
    message: 'Initial commit',
    authorLogin: 'mirage',
    date: ROOT_COMMIT_DATE,
    treeSha: '',
    authorJson: '',
    committerJson: '',
    seq: -1,
  }
}

export function errorBody(message: string): JsonValue {
  return { message, documentation_url: 'https://docs.github.com/rest' }
}

export const DEFAULT_USER = DEFAULT_LOGIN
