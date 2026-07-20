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

import { mountKey, mountPrefixOf } from '../../utils/key_prefix.ts'
import type { LinearAccessor } from '../../accessor/linear.ts'
import { IndexEntry } from '../../cache/index/config.ts'
import type { IndexCacheStore } from '../../cache/index/store.ts'
import { PathSpec } from '../../types.ts'
import {
  listTeamCycles,
  listTeamDocuments,
  listTeamIssues,
  listTeamMembers,
  listTeamProjects,
  listTeams,
} from './_client.ts'
import {
  cycleFilename,
  documentFilename,
  issueDirname,
  memberFilename,
  projectFilename,
  teamDirname,
} from './pathing.ts'
import { stripSlash } from '../../utils/slash.ts'
import { enoent } from '../../utils/errors.ts'

export interface LinearReaddirFilter {
  teamIds?: readonly string[]
}

function pickString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  return typeof value === 'string' ? value : ''
}

function makeVirtualKey(prefix: string, key: string): string {
  if (key === '') return prefix !== '' ? prefix : '/'
  return `${prefix}/${key}`
}

async function ensureLookup(
  accessor: LinearAccessor,
  index: IndexCacheStore,
  filter: LinearReaddirFilter,
  prefix: string,
  parentKey: string,
  virtualKey: string,
): Promise<{ id: string }> {
  let lookup = await index.get(virtualKey)
  if (lookup.entry === undefined || lookup.entry === null) {
    const parentPath = `${prefix}/${parentKey}`
    await readdir(
      accessor,
      new PathSpec({
        virtual: parentPath,
        directory: parentPath,
        resourcePath: mountKey(parentPath, prefix),
      }),
      index,
      filter,
    )
    lookup = await index.get(virtualKey)
  }
  if (lookup.entry === undefined || lookup.entry === null) {
    throw enoent(virtualKey)
  }
  return { id: lookup.entry.id }
}

export async function readdir(
  accessor: LinearAccessor,
  path: PathSpec,
  index?: IndexCacheStore,
  filter: LinearReaddirFilter = {},
): Promise<string[]> {
  const prefix = mountPrefixOf(path.virtual, path.resourcePath)
  let p = path.pattern !== null ? path.directory : path.virtual
  if (prefix !== '' && p.startsWith(prefix)) {
    p = p.slice(prefix.length) || '/'
  }
  const key = stripSlash(p)
  const virtualKey = makeVirtualKey(prefix, key)

  if (key === '') {
    return [`${prefix}/teams`]
  }

  if (key === 'teams') {
    if (index !== undefined) {
      const listing = await index.listDir(virtualKey)
      if (listing.entries !== undefined && listing.entries !== null) {
        return listing.entries
      }
    }
    let teams = await listTeams(accessor.transport)
    if (filter.teamIds !== undefined && filter.teamIds.length > 0) {
      const allowed = new Set(filter.teamIds)
      teams = teams.filter((t) => allowed.has(pickString(t, 'id')))
    }
    const entries: [string, IndexEntry][] = []
    const names: string[] = []
    for (const team of teams) {
      const dirname = teamDirname(team)
      entries.push([
        dirname,
        new IndexEntry({
          id: pickString(team, 'id'),
          name: pickString(team, 'name') || pickString(team, 'key') || pickString(team, 'id'),
          resourceType: 'linear/team',
          remoteTime: pickString(team, 'updatedAt'),
          vfsName: dirname,
        }),
      ])
      names.push(`${prefix}/teams/${dirname}`)
    }
    if (index !== undefined) await index.setDir(virtualKey, entries)
    return names
  }

  const parts = key.split('/')

  if (parts.length === 2 && parts[0] === 'teams') {
    if (index !== undefined) {
      await ensureLookup(accessor, index, filter, prefix, 'teams', virtualKey)
    }
    return [
      `${prefix}/${key}/team.json`,
      `${prefix}/${key}/members`,
      `${prefix}/${key}/issues`,
      `${prefix}/${key}/projects`,
      `${prefix}/${key}/cycles`,
      `${prefix}/${key}/documents`,
    ]
  }

  if (parts.length === 3 && parts[0] === 'teams' && parts[2] === 'members') {
    if (index === undefined) throw enoent(path)
    const teamKey = makeVirtualKey(prefix, parts.slice(0, 2).join('/'))
    const team = await ensureLookup(accessor, index, filter, prefix, 'teams', teamKey)
    const listing = await index.listDir(virtualKey)
    if (listing.entries !== undefined && listing.entries !== null) {
      return listing.entries
    }
    const users = await listTeamMembers(accessor.transport, team.id)
    const entries: [string, IndexEntry][] = []
    const names: string[] = []
    for (const user of users) {
      const filename = memberFilename(user)
      entries.push([
        filename,
        new IndexEntry({
          id: pickString(user, 'id'),
          name:
            pickString(user, 'name') || pickString(user, 'displayName') || pickString(user, 'id'),
          resourceType: 'linear/user',
          remoteTime: pickString(user, 'updatedAt'),
          vfsName: filename,
        }),
      ])
      names.push(`${prefix}/${key}/${filename}`)
    }
    await index.setDir(virtualKey, entries)
    return names
  }

  if (parts.length === 3 && parts[0] === 'teams' && parts[2] === 'issues') {
    if (index === undefined) throw enoent(path)
    const teamKey = makeVirtualKey(prefix, parts.slice(0, 2).join('/'))
    const team = await ensureLookup(accessor, index, filter, prefix, 'teams', teamKey)
    const listing = await index.listDir(virtualKey)
    if (listing.entries !== undefined && listing.entries !== null) {
      return listing.entries
    }
    const issues = await listTeamIssues(accessor.transport, team.id)
    const entries: [string, IndexEntry][] = []
    const names: string[] = []
    for (const issue of issues) {
      const dirname = issueDirname(issue)
      entries.push([
        dirname,
        new IndexEntry({
          id: pickString(issue, 'id'),
          name: pickString(issue, 'identifier') || pickString(issue, 'id'),
          resourceType: 'linear/issue',
          remoteTime: pickString(issue, 'updatedAt'),
          vfsName: dirname,
        }),
      ])
      names.push(`${prefix}/${key}/${dirname}`)
    }
    await index.setDir(virtualKey, entries)
    return names
  }

  if (parts.length === 4 && parts[0] === 'teams' && parts[2] === 'issues') {
    if (index !== undefined) {
      const parentKey = parts.slice(0, 3).join('/')
      await ensureLookup(accessor, index, filter, prefix, parentKey, virtualKey)
    }
    return [`${prefix}/${key}/issue.json`, `${prefix}/${key}/comments.jsonl`]
  }

  if (parts.length === 3 && parts[0] === 'teams' && parts[2] === 'projects') {
    if (index === undefined) throw enoent(path)
    const teamKey = makeVirtualKey(prefix, parts.slice(0, 2).join('/'))
    const team = await ensureLookup(accessor, index, filter, prefix, 'teams', teamKey)
    const listing = await index.listDir(virtualKey)
    if (listing.entries !== undefined && listing.entries !== null) {
      return listing.entries
    }
    const projects = await listTeamProjects(accessor.transport, team.id)
    const entries: [string, IndexEntry][] = []
    const names: string[] = []
    for (const project of projects) {
      const filename = projectFilename(project)
      entries.push([
        filename,
        new IndexEntry({
          id: pickString(project, 'id'),
          name: pickString(project, 'name') || pickString(project, 'id'),
          resourceType: 'linear/project',
          remoteTime: pickString(project, 'updatedAt'),
          vfsName: filename,
        }),
      ])
      names.push(`${prefix}/${key}/${filename}`)
    }
    await index.setDir(virtualKey, entries)
    return names
  }

  if (parts.length === 3 && parts[0] === 'teams' && parts[2] === 'cycles') {
    if (index === undefined) throw enoent(path)
    const teamKey = makeVirtualKey(prefix, parts.slice(0, 2).join('/'))
    const team = await ensureLookup(accessor, index, filter, prefix, 'teams', teamKey)
    const listing = await index.listDir(virtualKey)
    if (listing.entries !== undefined && listing.entries !== null) {
      return listing.entries
    }
    const cycles = await listTeamCycles(accessor.transport, team.id)
    const entries: [string, IndexEntry][] = []
    const names: string[] = []
    for (const cycle of cycles) {
      const filename = cycleFilename(cycle)
      entries.push([
        filename,
        new IndexEntry({
          id: pickString(cycle, 'id'),
          name: pickString(cycle, 'name') || pickString(cycle, 'id'),
          resourceType: 'linear/cycle',
          remoteTime: pickString(cycle, 'updatedAt'),
          vfsName: filename,
        }),
      ])
      names.push(`${prefix}/${key}/${filename}`)
    }
    await index.setDir(virtualKey, entries)
    return names
  }

  if (parts.length === 3 && parts[0] === 'teams' && parts[2] === 'documents') {
    if (index === undefined) throw enoent(path)
    const teamKey = makeVirtualKey(prefix, parts.slice(0, 2).join('/'))
    const team = await ensureLookup(accessor, index, filter, prefix, 'teams', teamKey)
    const listing = await index.listDir(virtualKey)
    if (listing.entries !== undefined && listing.entries !== null) {
      return listing.entries
    }
    const documents = await listTeamDocuments(accessor.transport, team.id)
    const entries: [string, IndexEntry][] = []
    const names: string[] = []
    for (const document of documents) {
      const filename = documentFilename(document)
      entries.push([
        filename,
        new IndexEntry({
          id: pickString(document, 'id'),
          name: pickString(document, 'title') || pickString(document, 'id'),
          resourceType: 'linear/document',
          remoteTime: pickString(document, 'updatedAt'),
          vfsName: filename,
        }),
      ])
      names.push(`${prefix}/${key}/${filename}`)
    }
    await index.setDir(virtualKey, entries)
    return names
  }

  return []
}
