import type { PathSpec } from '@struktoai/mirage-core/types'
import type { NextcloudAccessor } from '../../../accessor/nextcloud.ts'
import {
  SEARCH_HEADERS,
  SEARCH_METHOD,
  SEARCH_PAGE_SIZE,
  UNAVAILABLE_STATUS_CODES,
} from './constants.ts'
import { requestBody } from './query.ts'
import { parsePage } from './response.ts'
import { searchTarget } from './target.ts'
import type { SearchEntry } from './types.ts'

function authorization(accessor: NextcloudAccessor): string | null {
  const username = accessor.config.username
  if (username === undefined || username === '') return null
  return `Basic ${Buffer.from(`${username}:${accessor.config.password ?? ''}`).toString('base64')}`
}

/**
 * Every file and folder under a directory, from Nextcloud's file search, a page
 * of a thousand per request. Null from a server without the search (plain
 * WebDAV), and for a `path` it cannot find or that is a file. Mirrors Python's
 * `search_files`.
 */
export async function searchFiles(
  accessor: NextcloudAccessor,
  path: PathSpec,
): Promise<SearchEntry[] | null> {
  const target = searchTarget(accessor.config.url)
  if (target === null) return null
  const headers: Record<string, string> = { ...SEARCH_HEADERS }
  const auth = authorization(accessor)
  if (auth !== null) headers.Authorization = auth
  const entries = new Map<string, SearchEntry>()
  let offset = 0
  for (;;) {
    const response = await fetch(target.endpoint, {
      method: SEARCH_METHOD,
      headers,
      body: requestBody(target, path, offset),
      signal: AbortSignal.timeout((accessor.config.timeout ?? 30) * 1000),
    })
    if (UNAVAILABLE_STATUS_CODES.has(response.status)) return null
    if (!response.ok) {
      throw new Error(`Nextcloud Files Search returned HTTP ${String(response.status)}`)
    }
    if (response.status !== 207) {
      throw new Error(
        `Nextcloud Files Search returned HTTP ${String(response.status)}, expected 207`,
      )
    }
    const page = parsePage(await response.text(), target)
    const previousSize = entries.size
    for (const entry of page) if (!entries.has(entry.key)) entries.set(entry.key, entry)
    if (page.length > 0 && entries.size === previousSize) return null
    if (page.length < SEARCH_PAGE_SIZE) break
    offset += page.length
  }
  return [...entries.values()]
}
