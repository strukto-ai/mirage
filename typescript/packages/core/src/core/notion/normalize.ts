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

import { formatSegment, stripDashes } from './pathing.ts'
import { blocksToMarkdown } from './render.ts'

type Json = Record<string, unknown>

const ID_PATTERN = /^[0-9a-f]{32}$/

function pickStringOrNull(record: Json, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' ? value : null
}

function strOf(record: Json, key: string): string {
  const value = record[key]
  return typeof value === 'string' ? value : ''
}

function boolOf(record: Json, key: string): boolean {
  const value = record[key]
  return typeof value === 'boolean' ? value : false
}

function asObject(value: unknown): Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {}
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function joinTitleFragments(fragments: unknown[]): string {
  let out = ''
  for (const fragment of fragments) {
    const obj = asObject(fragment)
    const text = pickStringOrNull(obj, 'plain_text')
    if (text !== null) out += text
  }
  return out
}

export function extractTitle(page: Json): string {
  const properties = asObject(page.properties)
  const titleProp = asObject(properties.title)
  const titleFragments = asArray(titleProp.title)
  if (titleFragments.length > 0) {
    const joined = joinTitleFragments(titleFragments)
    if (joined !== '') return joined
  }
  const nameProp = asObject(properties.Name)
  const nameFragments = asArray(nameProp.title)
  if (nameFragments.length > 0) {
    const joined = joinTitleFragments(nameFragments)
    if (joined !== '') return joined
  }
  return 'untitled'
}

export function extractIdNoDashes(page: Json): string {
  const id = pickStringOrNull(page, 'id')
  if (id === null) {
    throw new Error('notion page missing id')
  }
  const stripped = stripDashes(id).toLowerCase()
  if (!ID_PATTERN.test(stripped)) {
    throw new Error('notion page missing id')
  }
  return stripped
}

export function pageSegmentName(page: Json): string {
  return formatSegment({ id: strOf(page, 'id'), title: pageContentTitle(page) })
}

export function pageContentTitle(page: Json): string {
  const properties = asObject(page.properties)
  for (const value of Object.values(properties)) {
    const prop = asObject(value)
    if (strOf(prop, 'type') === 'title') {
      return joinTitleFragments(asArray(prop.title))
    }
  }
  return ''
}

function extractDatabaseTitle(database: Json): string {
  const titleFragments = asArray(database.title)
  if (titleFragments.length > 0) {
    const joined = joinTitleFragments(titleFragments)
    if (joined !== '') return joined
  }
  return 'untitled'
}

export function databaseSegmentName(database: Json): string {
  return formatSegment({ id: strOf(database, 'id'), title: extractDatabaseTitle(database) })
}

export interface NormalizedPage {
  page_id: string
  title: string
  url: string
  created_time: string
  last_edited_time: string
  parent_type: string
  parent_id: string
  archived: boolean
  created_by: string
  last_edited_by: string
  markdown: string
  blocks: Json[]
}

export interface NormalizedDatabase {
  database_id: string
  title: string
  url: string | null
  created_time: string | null
  last_edited_time: string | null
  parent: Json
  archived: boolean
  is_inline: boolean
  properties: Json
}

export function normalizePage(page: Json, blocks: readonly Json[]): NormalizedPage {
  const parent = asObject(page.parent)
  const parentType = strOf(parent, 'type')
  const rawParentId = parent[parentType]
  const parentId = typeof rawParentId === 'string' ? rawParentId : ''
  const contentBlocks = (blocks as Json[]).filter((block) => {
    const type = strOf(block, 'type')
    return type !== 'child_page' && type !== 'child_database'
  })
  return {
    page_id: strOf(page, 'id'),
    title: pageContentTitle(page),
    url: strOf(page, 'url'),
    created_time: strOf(page, 'created_time'),
    last_edited_time: strOf(page, 'last_edited_time'),
    parent_type: parentType,
    parent_id: parentId,
    archived: boolOf(page, 'archived'),
    created_by: strOf(asObject(page.created_by), 'id'),
    last_edited_by: strOf(asObject(page.last_edited_by), 'id'),
    markdown: blocksToMarkdown(contentBlocks),
    blocks: contentBlocks,
  }
}

export function normalizeDatabase(database: Json): NormalizedDatabase {
  const archived =
    database.archived !== undefined ? boolOf(database, 'archived') : boolOf(database, 'in_trash')
  return {
    database_id: strOf(database, 'id'),
    title: extractDatabaseTitle(database),
    url: pickStringOrNull(database, 'url'),
    created_time: pickStringOrNull(database, 'created_time'),
    last_edited_time: pickStringOrNull(database, 'last_edited_time'),
    parent: asObject(database.parent),
    archived,
    is_inline: boolOf(database, 'is_inline'),
    properties: asObject(database.properties),
  }
}

export function toJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value, null, 2))
}
