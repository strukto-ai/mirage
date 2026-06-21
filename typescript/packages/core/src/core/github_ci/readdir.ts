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

import type { GitHubCIAccessor } from '../../accessor/github_ci.ts'
import { IndexEntry } from '../../cache/index/config.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { PathSpec } from '../../types.ts'
import { listArtifacts } from './artifacts.ts'
import { listJobsForRun, listRuns } from './runs.ts'
import { listWorkflows } from './workflows.ts'
import { stripSlash } from '../../utils/slash.ts'
import { enoent } from '../../utils/errors.ts'

function safeName(name: string | undefined): string {
  if (name === undefined || name === '') return 'unknown'
  return name.replace(/\//g, '\u2215')
}

function stripPrefix(path: PathSpec): string {
  const prefix = path.prefix
  let p = path.pattern !== null ? path.directory : path.original
  if (prefix !== '' && p.startsWith(prefix)) {
    p = p.slice(prefix.length) || '/'
  }
  return p
}

export async function readdir(
  accessor: GitHubCIAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
): Promise<string[]> {
  const prefix = path.prefix
  const stripped = stripPrefix(path)
  const key = stripSlash(stripped)
  const virtualKey = key === '' ? (prefix === '' ? '/' : prefix) : `${prefix}/${key}`

  if (key === '') {
    return [`${prefix}/workflows`, `${prefix}/runs`]
  }

  const parts = key.split('/')

  if (parts.length === 1 && parts[0] === 'workflows') {
    if (index !== undefined) {
      const listing = await index.listDir(virtualKey)
      if (listing.entries !== undefined && listing.entries !== null) return listing.entries
    }
    const workflows = await listWorkflows(accessor.transport, accessor.owner, accessor.repo)
    const entries: [string, IndexEntry][] = []
    const names: string[] = []
    for (const wf of workflows) {
      const name = safeName(wf.name)
      const filename = `${name}_${String(wf.id)}.json`
      const entry = new IndexEntry({
        id: String(wf.id),
        name: wf.name ?? '',
        resourceType: 'ci/workflow',
        remoteTime: wf.updated_at ?? '',
        vfsName: filename,
      })
      entries.push([filename, entry])
      names.push(`${prefix}/${key}/${filename}`)
    }
    if (index !== undefined) await index.setDir(virtualKey, entries)
    return names
  }

  if (parts.length === 1 && parts[0] === 'runs') {
    if (index !== undefined) {
      const listing = await index.listDir(virtualKey)
      if (listing.entries !== undefined && listing.entries !== null) return listing.entries
    }
    const runs = await listRuns(
      accessor.transport,
      accessor.owner,
      accessor.repo,
      accessor.days,
      accessor.maxRuns,
    )
    const entries: [string, IndexEntry][] = []
    const names: string[] = []
    for (const r of runs) {
      const wfName = safeName(r.name)
      const dirname = `${wfName}_${String(r.id)}`
      const entry = new IndexEntry({
        id: String(r.id),
        name: r.name ?? '',
        resourceType: 'ci/run',
        vfsName: dirname,
        remoteTime: r.updated_at ?? '',
      })
      entries.push([dirname, entry])
      names.push(`${prefix}/${key}/${dirname}`)
    }
    if (index !== undefined) await index.setDir(virtualKey, entries)
    return names
  }

  if (parts.length === 2 && parts[0] === 'runs') {
    if (index !== undefined) {
      const lookup = await index.get(virtualKey)
      if (lookup.entry === undefined || lookup.entry === null) {
        const parent = new PathSpec({
          original: `${prefix}/runs`,
          directory: `${prefix}/runs`,
          resolved: false,
          prefix,
        })
        await readdir(accessor, parent, index)
        const recheck = await index.get(virtualKey)
        if (recheck.entry === undefined || recheck.entry === null) {
          throw enoent(path.original)
        }
      }
    }
    const base = `${prefix}/${key}`
    return [`${base}/run.json`, `${base}/jobs`, `${base}/annotations.jsonl`, `${base}/artifacts`]
  }

  if (parts.length === 3 && parts[0] === 'runs' && parts[2] === 'jobs') {
    if (index === undefined) throw enoent(path.original)
    const listing = await index.listDir(virtualKey)
    if (listing.entries !== undefined && listing.entries !== null) return listing.entries
    const runDirname = parts[1]
    if (runDirname === undefined) throw enoent(path.original)
    const runVirtual = `${prefix}/runs/${runDirname}`
    let runLookup = await index.get(runVirtual)
    if (runLookup.entry === undefined || runLookup.entry === null) {
      const parent = new PathSpec({
        original: `${prefix}/runs`,
        directory: `${prefix}/runs`,
        resolved: false,
        prefix,
      })
      await readdir(accessor, parent, index)
      runLookup = await index.get(runVirtual)
    }
    if (runLookup.entry === undefined || runLookup.entry === null) {
      throw enoent(path.original)
    }
    const runId = runLookup.entry.id
    const jobs = await listJobsForRun(accessor.transport, accessor.owner, accessor.repo, runId)
    const entries: [string, IndexEntry][] = []
    const names: string[] = []
    for (const j of jobs) {
      const name = safeName(j.name)
      const jsonFilename = `${name}_${String(j.id)}.json`
      const logFilename = `${name}_${String(j.id)}.log`
      entries.push([
        jsonFilename,
        new IndexEntry({
          id: String(j.id),
          name: j.name ?? '',
          resourceType: 'ci/job',
          vfsName: jsonFilename,
          remoteTime: j.completed_at ?? '',
        }),
      ])
      entries.push([
        logFilename,
        new IndexEntry({
          id: String(j.id),
          name: j.name ?? '',
          resourceType: 'ci/job_log',
          vfsName: logFilename,
          remoteTime: j.completed_at ?? '',
        }),
      ])
      names.push(`${prefix}/${key}/${jsonFilename}`)
      names.push(`${prefix}/${key}/${logFilename}`)
    }
    await index.setDir(virtualKey, entries)
    return names
  }

  if (parts.length === 3 && parts[0] === 'runs' && parts[2] === 'artifacts') {
    if (index === undefined) throw enoent(path.original)
    const listing = await index.listDir(virtualKey)
    if (listing.entries !== undefined && listing.entries !== null) return listing.entries
    const runDirname = parts[1]
    if (runDirname === undefined) throw enoent(path.original)
    const runVirtual = `${prefix}/runs/${runDirname}`
    let runLookup = await index.get(runVirtual)
    if (runLookup.entry === undefined || runLookup.entry === null) {
      const parent = new PathSpec({
        original: `${prefix}/runs`,
        directory: `${prefix}/runs`,
        resolved: false,
        prefix,
      })
      await readdir(accessor, parent, index)
      runLookup = await index.get(runVirtual)
    }
    if (runLookup.entry === undefined || runLookup.entry === null) {
      throw enoent(path.original)
    }
    const runId = runLookup.entry.id
    const artifacts = await listArtifacts(accessor.transport, accessor.owner, accessor.repo, runId)
    const entries: [string, IndexEntry][] = []
    const names: string[] = []
    for (const a of artifacts) {
      const name = safeName(a.name)
      const filename = `${name}_${String(a.id)}.zip`
      entries.push([
        filename,
        new IndexEntry({
          id: String(a.id),
          name: a.name ?? '',
          resourceType: 'ci/artifact',
          remoteTime: a.updated_at ?? '',
          vfsName: filename,
          size: a.size_in_bytes ?? null,
        }),
      ])
      names.push(`${prefix}/${key}/${filename}`)
    }
    await index.setDir(virtualKey, entries)
    return names
  }

  return []
}
