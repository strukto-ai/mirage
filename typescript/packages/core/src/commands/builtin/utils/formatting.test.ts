import { describe, expect, it } from 'vitest'
import { FileStat, FileType } from '../../../types.ts'
import { parseBlockSize, formatLsLong } from './formatting.ts'

describe('parseBlockSize', () => {
  // strtol's blanks and `+` are skipped only in front of a digit (coreutils 9.7).
  it.each([
    [' +1', 1],
    ['+1K', 1024],
    [' 1K', 1024],
  ])('reads %j as %d', (text, size) => {
    const parsed = parseBlockSize(text)
    expect(typeof parsed).toBe('object')
    if (typeof parsed === 'object') expect(parsed.divisor).toBe(size)
  })

  // The unit is echoed only when the value was a bare unit (coreutils 9.7).
  it.each([
    ['K', 'K'],
    ['KB', 'kB'],
    ['KiB', 'KiB'],
    ['1K', ''],
    ['2K', ''],
  ])('shows the suffix of %j as %j', (text, suffix) => {
    const parsed = parseBlockSize(text)
    if (typeof parsed === 'object') expect(parsed.suffix).toBe(suffix)
    else expect.fail(parsed)
  })

  it.each(['+K', ' K', '+ 1', '+', ' ', 'bogus', '0', ''])('refuses %j as invalid', (text) => {
    expect(parseBlockSize(text)).toBe('invalid')
  })
})

it.each([
  [null, '2020-01-02T03:04:00Z', '- Jan  2  2020'],
  [0, null, '0 -'],
  [null, null, '- -'],
] as const)('keeps unknown size and time independent', (size, modified, expected) => {
  const row = new FileStat({ name: 'file', type: FileType.FILE, size, modified })
  expect(formatLsLong([row])[0]).toMatch(new RegExp(`${expected} file$`))
})
