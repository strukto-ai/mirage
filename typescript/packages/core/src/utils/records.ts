import type { JsonObject } from '../types.ts'

/** A JSON object, excluding null and arrays. */
export function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** A document mapping, excluding instances such as Date and Set. */
export function isPlainObject(value: unknown): value is JsonObject {
  if (!isRecord(value)) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

export function asObject(value: unknown): JsonObject {
  return isRecord(value) ? value : {}
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export function records(value: unknown): JsonObject[] {
  return asArray(value).filter(isRecord)
}

/** First string field, including an explicitly empty string. */
export function pickString(record: JsonObject, ...keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string') return value
  }
  return null
}

export function stringOf(record: JsonObject, key: string): string {
  return pickString(record, key) ?? ''
}

/** First nonempty string, for labels whose empty spelling means absent. */
export function firstText(record: JsonObject, ...keys: readonly string[]): string {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return ''
}

export function pickBoolOrNull(record: JsonObject, key: string): boolean | null {
  const value = record[key]
  return typeof value === 'boolean' ? value : null
}

export function pickNumberOrNull(record: JsonObject, key: string): number | null {
  const value = record[key]
  return typeof value === 'number' ? value : null
}

export function pickStringArray(record: JsonObject, key: string): string[] {
  return asArray(record[key]).filter((value): value is string => typeof value === 'string')
}

export function requireId(record: JsonObject): string {
  const id = firstText(record, 'id')
  if (id === '') throw new Error('record missing id')
  return id
}
