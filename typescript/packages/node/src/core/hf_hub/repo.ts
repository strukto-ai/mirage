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

import type { HfHubAccessor } from '../../accessor/hf_hub.ts'
import { apiUrl, HfHubError, hubGet, revSegment } from './client.ts'

/**
 * The version a mount's listings are stored and checked at.
 *
 * The head commit, joined with the key prefix when the mount has one: the
 * index keys are mount-relative, so two mounts of one repository at one head
 * but different key prefixes hold different listings under the same keys, and
 * must not match each other's version. ':' cannot occur in a hex sha, and a
 * mount with no key prefix keeps the plain head.
 *
 * Mirrors Python's `mount_version`.
 */
export function mountVersion(head: string | null, keyPrefix: string): string | null {
  if (head === null || head === '') return null
  return keyPrefix === '' ? head : `${head}:${keyPrefix}`
}

/**
 * The commit the mount's revision currently points at.
 *
 * Read from the repo object rather than from /refs because the repo object
 * answers it for a tag and a commit-pinned mount too, where /refs only
 * enumerates branches.
 *
 * Asked of the revision endpoint, not the bare one: the bare object's `sha`
 * is the default branch's whatever revision was requested, and the cache is
 * keyed by this sha. Reading the wrong one files a `--revision dev` download
 * under main's snapshot and points refs/dev at it, so a later main download
 * finds the snapshot already there and serves dev's bytes.
 */
export async function headCommit(accessor: HfHubAccessor): Promise<string> {
  // Only the sha is read, so only the sha is asked for: the bare object lists
  // every file (1.5 MB on a large dataset), the trimmed one is about 110
  // bytes. A param, never part of revisionUrl, which every not-found message
  // names verbatim.
  const data = await hubGet(accessor.account, revisionUrl(accessor), { 'expand[]': 'sha' })
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return ''
  const sha = (data as Record<string, unknown>).sha
  return typeof sha === 'string' ? sha : ''
}

/** What the Hub says is missing when a listing came back empty. */
export enum Absence {
  PRESENT = 'present',
  REPO = 'repo',
  REVISION = 'revision',
}

/** The endpoint whose url upstream names in its not-found messages. */
export function revisionUrl(accessor: HfHubAccessor): string {
  return apiUrl(
    accessor.endpoint,
    accessor.repoType,
    accessor.repoId,
    `/revision/${revSegment(accessor.revision)}`,
  )
}

/**
 * Why a listing came back empty, asked of the Hub directly.
 *
 * `hf download` folds a tree walk the Hub refused (401/403/404) into an empty
 * listing itself, so its failure path can name the absence upstream would. It
 * asks this on that path only, which costs one request and only when something
 * already went wrong.
 *
 * The status cannot answer it. A missing repository, a missing revision and a
 * missing file are all 404, and only the Hub's `X-Error-Code` header tells
 * them apart; probed against the live Hub, not inferred.
 */
export async function classifyAbsence(accessor: HfHubAccessor): Promise<Absence> {
  try {
    await hubGet(accessor.account, revisionUrl(accessor))
  } catch (err) {
    if (err instanceof HfHubError) {
      if (err.errorCode === 'RepoNotFound') return Absence.REPO
      if (err.errorCode === 'RevisionNotFound') return Absence.REVISION
    }
    throw err
  }
  return Absence.PRESENT
}
