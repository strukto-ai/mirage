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

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

import { SeedError } from '../kit/typescript/index.ts'
import type { JsonValue } from '../kit/typescript/index.ts'
import type { DatabaseSync } from 'node:sqlite'
import type {
  GithubCheck,
  GithubRun,
  GithubSetting,
  GithubStatus,
  GithubTagRef,
} from '../../generated/github/index.js'
import { count, first, insert, select } from '../kit/typescript/index.ts'
import type { C } from './config.ts'
import { workflowsOf } from './actions.ts'
import { DMMF, addBranch, allRepos, resolveRef } from './store.ts'
import type { Db, RepoRow } from './store.ts'

// A fixture root file naming submodule gitlink paths, one per line. It is a
// manifest rather than repository content, so it never becomes a GithubFile.
const SUBMODULES = 'SUBMODULES'

function walkFiles(root: string): string[] {
  const out: string[] = []
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) visit(full)
      else out.push(full)
    }
  }
  visit(root)
  return out.sort()
}

// Two models, so two counts. Returning one total made /reset publish the sum
// as GithubFile and never mention GithubSubmodule, which is exactly the drift
// the per-model row report exists to catch.
interface TreeCounts {
  files: number
  submodules: number
}

async function loadTree(
  db: Db,
  tenant: string,
  repo: RepoRow,
  fixtureRoot: string,
): Promise<TreeCounts> {
  if (repo.sourceDir === '') return { files: 0, submodules: 0 }
  const root = join(fixtureRoot, ...repo.sourceDir.split('/'))
  const branch = repo.sourceBranch === '' ? repo.defaultBranch : repo.sourceBranch
  await addBranch(db, tenant, repo.fullName, branch)
  let seq = 0
  let subs = 0
  for (const full of walkFiles(root)) {
    const rel = relative(root, full).split(sep).join('/')
    if (rel === SUBMODULES) {
      const lines = readFileSync(full, 'utf8').split('\n')
      for (const line of lines) {
        const path = line.trim()
        if (path === '') continue
        insert(db, 'GithubSubmodule', { tenant, repo: repo.fullName, path })
        subs += 1
      }
      continue
    }
    insert(db, 'GithubFile', {
      tenant,
      repo: repo.fullName,
      branch,
      path: rel,
      data: readFileSync(full),
      seq,
    })
    seq += 1
  }
  return { files: seq, submodules: subs }
}

// Everything a repository has the moment it exists, in ONE place: its default
// branch. Every creation path calls this, and a new piece of per-repository
// state is added here rather than at three call sites. Its CI state is not
// among it: a check or a status belongs to the commit it was set on, so a
// fixture states the ones a repository's commits carry, and a repository made
// through the API starts with none, as on GitHub. Workflows follow the files,
// so a fork has its source's and a new repository has none until it holds a
// workflow file.
export async function initRepo(db: Db, tenant: string, repo: RepoRow): Promise<void> {
  await addBranch(db, tenant, repo.fullName, repo.defaultBranch)
}

// What a fixture cannot state: a repository's 120 files come from the directory
// its row names, and every repository starts with the state initRepo gives it.
// Both are counted into the /reset report, because a table no fixture key names
// would otherwise read back as empty. Each repository's workflow files are
// registered here too, after every fixture row: a row the fixture states keeps
// its id, and the rest take theirs in repository and path order, the same on
// every reset rather than in whatever order requests first list them.
export async function seedRepos(
  _db: C,
  tenant: string,
  counts: Record<string, number>,
  _extras: Record<string, JsonValue>,
  fixtureRoot: string,
  _epoch: string | undefined,
  db: DatabaseSync,
): Promise<void> {
  let files = 0
  let submodules = 0
  const repos = await allRepos(db, tenant)
  for (const repo of repos) {
    await initRepo(db, tenant, repo)
    const loaded = await loadTree(db, tenant, repo, fixtureRoot)
    files += loaded.files
    submodules += loaded.submodules
  }
  for (const repo of repos) await workflowsOf(db, tenant, repo)
  await namedCommitsExist(db, tenant, repos)
  if (files > 0) counts.GithubFile = files
  if (submodules > 0) counts.GithubSubmodule = submodules
  const workflows = count(db, 'GithubWorkflow', '"tenant" = ?', tenant)
  if (workflows > 0) counts.GithubWorkflow = workflows
  const sorted = Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : 1))
  for (const key of Object.keys(counts)) delete counts[key]
  for (const [key, value] of sorted) counts[key] = value
}

// A run, a check, a status or a tag a fixture states names a commit its
// repository holds, or the fixture is refused at /reset: a sha that names
// nothing reads back as CI state no commit carries, which is how a fixture's
// shas went stale once its tree changed.
async function namedCommitsExist(db: Db, tenant: string, repos: RepoRow[]): Promise<void> {
  for (const repo of repos) {
    const where = '"tenant" = ? AND "repo" = ?'
    const at = [tenant, repo.fullName]
    const named: Array<[string, string]> = [
      ...select<GithubRun>(db, DMMF, 'GithubRun', where, ...at).map((r): [string, string] => [
        'run',
        r.headSha,
      ]),
      ...select<GithubCheck>(db, DMMF, 'GithubCheck', where, ...at).map((r): [string, string] => [
        'check',
        r.sha,
      ]),
      ...select<GithubStatus>(db, DMMF, 'GithubStatus', where, ...at).map((r): [string, string] => [
        'status',
        r.sha,
      ]),
      ...select<GithubTagRef>(db, DMMF, 'GithubTagRef', where, ...at).map((r): [string, string] => [
        'tag',
        r.sha,
      ]),
    ]
    for (const [kind, sha] of named) {
      const at = await resolveRef(db, tenant, repo, sha)
      if (at?.history[0]?.sha !== sha) {
        throw new SeedError(`github fixture: ${repo.fullName} ${kind} names no commit ${sha}`)
      }
    }
  }
}

export async function createReposAllowed(db: Db, tenant: string): Promise<boolean> {
  const row = first<GithubSetting>(db, DMMF, 'GithubSetting', '"tenant" = ?', tenant)
  return row === null || row.createRepos
}
