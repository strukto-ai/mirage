import { compareCodePoints } from '../utils/sort.ts'
import type { Accessor } from '../accessor/base.ts'
import type { IndexCacheStore } from '../cache/index/store.ts'
import type { PathSpec } from '../types.ts'
import type { SearchOps, SearchQuery } from './types.ts'

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
  const records: [string, string][] = []
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
  return new TextEncoder().encode(
    records.length === 0 ? '' : records.map(([, record]) => record).join('\n') + '\n',
  )
}
