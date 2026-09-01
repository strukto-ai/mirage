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

// The store keeps a commit's paths as strings, because that is all a write
// knows; the endpoints that report what changed answer with objects.
export function commitFiles(paths: string[], status = 'added'): JsonValue {
  return paths.map((filename) => ({ filename, status }))
}

export interface CommitRow {
  sha: string
  parentSha: string
  message: string
  authorLogin: string
  date: string
  filesJson: string
  treeSha: string
  authorJson: string
  committerJson: string
  seq: number
}

export function pathsOf(row: { filesJson: string }): string[] {
  const parsed = JSON.parse(row.filesJson) as JsonValue
  return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : []
}

// A stored commit as the LIST endpoints report it. GitHub's list and write
// shapes carry no `files` key at all; serving one handed clients bare strings
// where the contract has objects, which broke history enumeration after the
// first write.
// A write records a commit carrying only a message, so its rendering omits the
// author blocks a seeded one has: the two shapes are not a default apart, and a
// golden renders the difference. An empty author is what tells them apart,
// because that is what `recordCommit` stores.
export function commitJson(row: CommitRow): JsonValue {
  if (row.authorLogin === '') {
    const people = commitPeople(row)
    return people === null
      ? writtenCommitJson(row)
      : { sha: row.sha, commit: { message: row.message, ...people } }
  }
  return {
    sha: row.sha,
    commit: {
      message: row.message,
      author: commitPerson(row.authorLogin, row.date),
      committer: commitPerson(row.authorLogin, row.date),
    },
    author: { login: row.authorLogin },
  }
}

export function writtenCommitJson(row: { sha: string; message: string }): JsonValue {
  return { sha: row.sha, commit: { message: row.message } }
}

export function rootCommit(tree: Array<[string, string]>): CommitRow {
  const sorted = [...tree].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return {
    sha: commitSha(`root\0${sorted.map(([p, b]) => `${p}:${b}`).join('\0')}`),
    parentSha: '',
    message: 'Initial commit',
    authorLogin: 'mirage',
    date: ROOT_COMMIT_DATE,
    filesJson: '[]',
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
