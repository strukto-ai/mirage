import { compareCodePoints } from '../utils/sort.ts'
import type { SearchQuery } from '../types.ts'

export function validateOptions(query: SearchQuery, allowed: readonly string[]): void {
  const unknown = Object.keys(query.options ?? {})
    .filter((key) => !allowed.includes(key))
    .sort(compareCodePoints)
  if (unknown.length > 0) throw new Error(`unknown options: ${unknown.join(', ')}`)
}

export function intOption(query: SearchQuery, key: string, fallback: number): number {
  const value = query.options?.[key] === undefined ? fallback : query.options[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    throw new Error(`${key} must be an integer`)
  return value
}

export function floatOption(query: SearchQuery, key: string, fallback: number): number {
  const value = query.options?.[key] === undefined ? fallback : query.options[key]
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new Error(`${key} must be a finite number`)
  return value
}

export function textOption(query: SearchQuery, key: string, fallback: string): string {
  const value = query.options?.[key] === undefined ? fallback : query.options[key]
  if (typeof value !== 'string') throw new Error(`${key} must be a string`)
  return value
}
