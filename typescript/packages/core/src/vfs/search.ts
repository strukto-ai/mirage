import { pathsScoped } from '../ops/namespace_view.ts'
import type { NamespaceView } from '../ops/types.ts'
import { compareCodePoints } from '../utils/sort.ts'
import type { Accessor } from '../accessor/base.ts'
import type { IndexCacheStore } from '../cache/index/store.ts'
import { PathSpec, type Visibility } from '../types.ts'
import type { SearchOps, SearchQuery, SearchResult } from './types.ts'
import { getAdmission, requireVisible, sessionVisibility } from '../context/session_context.ts'
import { eacces } from '../errors/fs.ts'
import { pathVisible } from '../utils/hidden.ts'

/** Whether permissions require per-file access instead of bulk search. */
export function searchScoped(ns: NamespaceView | undefined, paths: readonly PathSpec[]): boolean {
  const gate = getAdmission()
  return gate === null ? pathsScoped(ns, paths) : paths.some((path) => gate.scopes(path.virtual))
}

/** Check search inputs before backend work and capture the reader's view. */
export function checkSearch(paths: readonly PathSpec[]): Visibility | null {
  const vis = sessionVisibility()
  const gate = getAdmission()
  for (const path of paths) {
    requireVisible(vis, path)
    // Permission refusals prevent backend access; scoped bulk searches
    // must use guarded file reads or refuse before reaching the service.
    if (gate?.scopes(path.virtual)) throw eacces(path)
  }
  return vis
}

/** Filter whole records by file path, including multiline bodies. */
export function visibleResults(
  results: Iterable<SearchResult>,
  vis: Visibility | null,
): SearchResult[] {
  const visible: SearchResult[] = []
  for (const result of results) {
    const candidate: unknown = result
    if (
      !Array.isArray(candidate) ||
      candidate.length !== 2 ||
      !(candidate[0] instanceof PathSpec) ||
      typeof candidate[1] !== 'string'
    )
      throw new Error('search: each result must carry a PathSpec and text')
    if (result[0].virtual !== PathSpec.fromStrPath(result[0].virtual, undefined, '/').virtual)
      throw new Error('search: result paths must be canonical absolute paths')
    if (pathVisible(vis, result[0])) visible.push(result)
  }
  return visible
}

export function validateOptions(query: SearchQuery, allowed: readonly string[]): void {
  const unknown = Object.keys(query.options ?? {})
    .filter((key) => !allowed.includes(key))
    .sort(compareCodePoints)
  if (unknown.length > 0) throw new Error(`search: unknown options: ${unknown.join(', ')}`)
}

export function intOption(query: SearchQuery, key: string, fallback: number): number {
  const value = query.options?.[key] === undefined ? fallback : query.options[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    throw new Error(`search: ${key} must be an integer`)
  return value
}

export function floatOption(query: SearchQuery, key: string, fallback: number): number {
  const value = query.options?.[key] === undefined ? fallback : query.options[key]
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new Error(`search: ${key} must be a finite number`)
  return value
}

export function textOption(query: SearchQuery, key: string, fallback: string): string {
  const value = query.options?.[key] === undefined ? fallback : query.options[key]
  if (typeof value !== 'string') throw new Error(`search: ${key} must be a string`)
  return value
}

/** Batch when supported; single-scope callbacks otherwise concatenate records. */
export async function searchResources<A extends Accessor>(
  capability: SearchOps<A> | undefined,
  accessor: A,
  paths: PathSpec[],
  query: SearchQuery,
  index?: IndexCacheStore,
): Promise<Uint8Array> {
  if (capability === undefined) throw new Error('search: backend does not support resource search')
  if (paths.length === 0) throw new Error('search: at least one scope is required')
  const vis = checkSearch(paths)
  const records: SearchResult[] = []
  if (capability.searchMany !== undefined) {
    const answer = await capability.searchMany(accessor, paths, query, index)
    if (answer === null) throw new Error('search: backend declined the query')
    records.push(...answer)
  } else {
    for (const path of paths) {
      const answer = await capability.search(accessor, path, query, index)
      if (answer === null) throw new Error('search: backend declined the query')
      records.push(...answer)
    }
  }
  const lines = visibleResults(records, vis).map(([, text]) => text)
  return new TextEncoder().encode(lines.length === 0 ? '' : lines.join('\n') + '\n')
}
