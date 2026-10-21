import { describe, expect, it } from 'vitest'
import { ContentType, DEVICE_NUMBERS_KEY, FileStat, FileType } from '../../../types.ts'
import {
  fullIsoTime,
  humanSize,
  parseBlockSize,
  formatLsLong,
  lsModeString,
  styledTime,
} from './formatting.ts'
import { resolveTz } from '../../../utils/timezone.ts'

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
  expect(formatLsLong([row])[0]).toBe(`-rw-r--r-- 1 - - ${expected} file`)
})

it('a fifo row is prw with size zero', () => {
  const row = new FileStat({ name: '63', type: FileType.FIFO })
  expect(lsModeString(row)).toBe('prw-------')
  const line = formatLsLong([row])[0] ?? ''
  expect(line.startsWith('prw------- ')).toBe(true)
  expect(line.endsWith(' 0 - 63')).toBe(true)
})

it('renders full-iso with the stamp digits in the zone', () => {
  const stamp = '2026-03-04T05:06:07.123456789Z'
  expect(fullIsoTime(stamp)).toBe('2026-03-04 05:06:07.123456789 +0000')
  expect(fullIsoTime(stamp, resolveTz('Asia/Hong_Kong'))).toBe(
    '2026-03-04 13:06:07.123456789 +0800',
  )
  expect(fullIsoTime(null, resolveTz('UTC-8'))).toBe('1970-01-01 08:00:00.000000000 +0800')
})

it.each([
  ['9999-12-31T23:59:59.999999', '9999-12-31 23:59:59.999999000 +0000'],
  ['2026-03-04T05:06:07.999999', '2026-03-04 05:06:07.999999000 +0000'],
])('never rounds %s into the next second', (stamp, shown) => {
  expect(fullIsoTime(stamp)).toBe(shown)
  expect(styledTime(stamp, 'full-iso')).toBe(shown)
})

// Read off GNU coreutils 9.7 (`ls -lh` on a file of each size, debian
// stable-slim). The three rows that matter are the ones a plain
// divide-and-format gets wrong: no suffix under 1024, rounding *up* to
// the shown precision (1025 -> 1.1K), and the decimal dropping once the
// value reaches ten (10240 -> 10K). 1048575 pins the carry: it ceils to
// 1024K, which GNU re-scales to 1.0M.
const GNU_HUMAN_SIZES: readonly (readonly [number, string])[] = [
  [0, '0'],
  [1, '1'],
  [24, '24'],
  [500, '500'],
  [999, '999'],
  [1000, '1000'],
  [1023, '1023'],
  [1024, '1.0K'],
  [1025, '1.1K'],
  [1126, '1.1K'],
  [1127, '1.2K'],
  [1536, '1.5K'],
  [2048, '2.0K'],
  [10188, '10K'],
  [10240, '10K'],
  [10241, '11K'],
  [11263, '11K'],
  [1048575, '1.0M'],
  [1048576, '1.0M'],
  [1024 * 1024 + 512 * 1024, '1.5M'],
  [1073741824, '1.0G'],
  // Past 2**53/10, so a `n * 10` intermediate stops being exact.
  // GNU says 1.8P; a float product rounds down and yields 1.7P.
  [1914029841632461, '1.8P'],
]

describe('humanSize', () => {
  it.each(GNU_HUMAN_SIZES)('formats %i as GNU does', (size, expected) => {
    expect(humanSize(size)).toBe(expected)
  })
})

describe('formatLsLong', () => {
  it('emits standard Unix ls -l format for a regular file', () => {
    const stat = new FileStat({
      name: 'file.txt',
      size: 5,
      type: FileType.FILE,
      content: ContentType.TEXT,
      modified: '2026-01-01T00:00:00Z',
    })
    const [line] = formatLsLong([stat])
    expect(line).toBe('-rw-r--r-- 1 - - 5 Jan  1  2026 file.txt')
  })

  it('renders the profile as both the owner and the group', () => {
    const stat = new FileStat({
      name: 'file.txt',
      size: 5,
      type: FileType.FILE,
      content: ContentType.TEXT,
      modified: '2026-01-01T00:00:00Z',
    })
    const identity = { profile: 'admin' }
    expect(formatLsLong([stat], { identity })[0]).toBe(
      '-rw-r--r-- 1 admin admin 5 Jan  1  2026 file.txt',
    )
    // A reported uid/gid (disk, or a chown in the overlay) wins over both.
    const owned = stat.with({ uid: 501, gid: 'staff' })
    expect(formatLsLong([owned], { identity })[0]).toBe(
      '-rw-r--r-- 1 501 staff 5 Jan  1  2026 file.txt',
    )
  })

  it('keeps the owner columns on a metadata-less row', () => {
    // A synthetic directory with neither size nor mtime shows DIR_SIZE
    // and `-` for the time rather than inventing the epoch, and still
    // names who the session is; a file with neither shows `-` for both.
    const stat = new FileStat({ name: 'dev', type: FileType.DIRECTORY })
    expect(formatLsLong([stat])[0]).toBe('drwxr-xr-x 1 - - 4096 - dev')
    expect(formatLsLong([stat], { identity: { profile: 'admin' } })[0]).toBe(
      'drwxr-xr-x 1 admin admin 4096 - dev',
    )
    expect(formatLsLong([stat], { human: true })[0]).toBe('drwxr-xr-x 1 - - 4.0K - dev')
    const page = new FileStat({ name: 'page', type: FileType.FILE })
    expect(formatLsLong([page])[0]).toBe('-rw-r--r-- 1 - - - - page')
  })

  it('renders a device row with its numbers in the size column', () => {
    const nul = new FileStat({
      name: 'null',
      type: FileType.CHAR_DEVICE,
      extra: { [DEVICE_NUMBERS_KEY]: [1, 3] },
    })
    expect(formatLsLong([nul], { identity: { profile: 'admin' } })[0]).toBe(
      'crw-rw-rw- 1 admin admin 1, 3 - null',
    )
  })

  it('emits "d" type char and dir perms for directories', () => {
    const stat = new FileStat({
      name: 'sub',
      size: 0,
      type: FileType.DIRECTORY,
      modified: '2026-01-01T00:00:00Z',
    })
    const [line] = formatLsLong([stat])
    expect(line?.startsWith('drwxr-xr-x ')).toBe(true)
    expect(line?.endsWith(' sub')).toBe(true)
  })

  it('right-aligns sizes to common width', () => {
    const stats = [
      new FileStat({
        name: 'a',
        size: 5,
        type: FileType.FILE,
        content: ContentType.TEXT,
        modified: '2026-01-01T00:00:00Z',
      }),
      new FileStat({
        name: 'b',
        size: 1234,
        type: FileType.FILE,
        content: ContentType.TEXT,
        modified: '2026-01-01T00:00:00Z',
      }),
    ]
    const lines = formatLsLong(stats)
    expect(lines[0]).toContain('    5 Jan  1  2026 a')
    expect(lines[1]).toContain(' 1234 Jan  1  2026 b')
  })

  it('uses humanSize when human=true', () => {
    const stat = new FileStat({
      name: 'big',
      size: 2048,
      type: FileType.FILE,
      content: ContentType.TEXT,
      modified: '2026-01-01T00:00:00Z',
    })
    const [line] = formatLsLong([stat], { human: true })
    expect(line).toContain('2.0K')
    expect(line).not.toContain(' 2048 ')
  })
})
