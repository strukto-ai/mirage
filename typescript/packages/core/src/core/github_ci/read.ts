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

import { mountPrefixOf } from '../../utils/key_prefix.ts'
import type { GitHubCIAccessor } from '../../accessor/github_ci.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import type { PathSpec } from '../../types.ts'
import { listAnnotations } from './annotations.ts'
import { downloadArtifact } from './artifacts.ts'
import { downloadJobLog, getJob, getRun, listJobsForRun } from './runs.ts'
import { getWorkflow } from './workflows.ts'
import { stripSlash } from '../../utils/slash.ts'
import { enoent } from '../../utils/errors.ts'

const ENC = new TextEncoder()

function stripPrefix(path: PathSpec): string {
  const prefix = mountPrefixOf(path.virtual, path.resourcePath)
  let p = path.virtual
  if (prefix !== '' && p.startsWith(prefix)) {
    p = p.slice(prefix.length) || '/'
  }
  return p
}

function jsonBytes(value: unknown): Uint8Array {
  return ENC.encode(JSON.stringify(value, null, 2))
}

export async function read(
  accessor: GitHubCIAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<Uint8Array> {
  const prefix = mountPrefixOf(path.virtual, path.resourcePath)
  const stripped = stripPrefix(path)
  const key = stripSlash(stripped)
  const parts = key === '' ? [] : key.split('/')
  const virtualKey = `${prefix}/${key}`

  if (parts.length === 2 && parts[0] === 'workflows' && parts[1]?.endsWith('.json') === true) {
    if (index === undefined) throw enoent(path)
    const lookup = await index.get(virtualKey)
    if (lookup.entry === undefined || lookup.entry === null) throw enoent(path)
    const wf = await getWorkflow(accessor.transport, accessor.owner, accessor.repo, lookup.entry.id)
    return jsonBytes(wf)
  }

  if (parts.length === 3 && parts[0] === 'runs' && parts[2] === 'run.json') {
    if (index === undefined) throw enoent(path)
    const runDirname = parts[1]
    if (runDirname === undefined) throw enoent(path)
    const runVirtual = `${prefix}/runs/${runDirname}`
    const lookup = await index.get(runVirtual)
    if (lookup.entry === undefined || lookup.entry === null) throw enoent(path)
    const run = await getRun(accessor.transport, accessor.owner, accessor.repo, lookup.entry.id)
    return jsonBytes(run)
  }

  if (parts.length === 3 && parts[0] === 'runs' && parts[2] === 'annotations.jsonl') {
    if (index === undefined) throw enoent(path)
    const runDirname = parts[1]
    if (runDirname === undefined) throw enoent(path)
    const runVirtual = `${prefix}/runs/${runDirname}`
    const lookup = await index.get(runVirtual)
    if (lookup.entry === undefined || lookup.entry === null) throw enoent(path)
    const jobs = await listJobsForRun(
      accessor.transport,
      accessor.owner,
      accessor.repo,
      lookup.entry.id,
    )
    const lines: string[] = []
    for (const j of jobs) {
      const anns = await listAnnotations(
        accessor.transport,
        accessor.owner,
        accessor.repo,
        String(j.id),
      )
      for (const a of anns) lines.push(JSON.stringify(a))
    }
    return lines.length > 0 ? ENC.encode(lines.join('\n') + '\n') : new Uint8Array(0)
  }

  if (
    parts.length === 4 &&
    parts[0] === 'runs' &&
    parts[2] === 'jobs' &&
    parts[3]?.endsWith('.json') === true
  ) {
    if (index === undefined) throw enoent(path)
    const lookup = await index.get(virtualKey)
    if (lookup.entry === undefined || lookup.entry === null) throw enoent(path)
    const job = await getJob(accessor.transport, accessor.owner, accessor.repo, lookup.entry.id)
    return jsonBytes(job)
  }

  if (
    parts.length === 4 &&
    parts[0] === 'runs' &&
    parts[2] === 'jobs' &&
    parts[3]?.endsWith('.log') === true
  ) {
    if (index === undefined) throw enoent(path)
    const lookup = await index.get(virtualKey)
    if (lookup.entry === undefined || lookup.entry === null) throw enoent(path)
    return downloadJobLog(accessor.transport, accessor.owner, accessor.repo, lookup.entry.id)
  }

  if (parts.length === 4 && parts[0] === 'runs' && parts[2] === 'artifacts') {
    if (index === undefined) throw enoent(path)
    const lookup = await index.get(virtualKey)
    if (lookup.entry === undefined || lookup.entry === null) throw enoent(path)
    return downloadArtifact(accessor.transport, accessor.owner, accessor.repo, lookup.entry.id)
  }

  throw enoent(path)
}

export async function* stream(
  accessor: GitHubCIAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): AsyncIterable<Uint8Array> {
  const data = await read(accessor, path, index)
  yield data
}
