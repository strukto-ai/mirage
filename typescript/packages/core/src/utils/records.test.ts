import { describe, expect, it } from 'vitest'
import {
  asArray,
  asObject,
  firstText,
  isPlainObject,
  pickBoolOrNull,
  pickNumberOrNull,
  pickString,
  pickStringArray,
  records,
  requireId,
  stringOf,
} from './records.ts'

describe('record fields', () => {
  it('distinguishes explicit empty text from a missing label', () => {
    const row = { preferred: '', fallback: 'name', wrong: 42 }
    expect(pickString(row, 'preferred', 'fallback')).toBe('')
    expect(firstText(row, 'preferred', 'fallback')).toBe('name')
    expect(pickString(row, 'wrong', 'fallback')).toBe('name')
    expect(stringOf(row, 'missing')).toBe('')
    expect(pickString(row, 'missing')).toBeNull()
  })
  it('keeps only the requested JSON types', () => {
    const row = { yes: true, zero: 0, strings: ['a', null, 2, ''], text: 'true' }
    expect(pickBoolOrNull(row, 'yes')).toBe(true)
    expect(pickBoolOrNull(row, 'text')).toBeNull()
    expect(pickNumberOrNull(row, 'zero')).toBe(0)
    expect(pickNumberOrNull(row, 'yes')).toBeNull()
    expect(pickStringArray(row, 'strings')).toEqual(['a', ''])
    expect(records([null, [], 4, row])).toEqual([row])
    expect(asArray({})).toEqual([])
    expect(asObject([])).toEqual({})
    expect(isPlainObject(new Date())).toBe(false)
    expect(isPlainObject(Object.create(null))).toBe(true)
  })
  it('requires an id without coercing it', () => {
    expect(requireId({ id: '0' })).toBe('0')
    for (const id of ['', 0, null, false])
      expect(() => requireId({ id })).toThrow('record missing id')
  })
})
