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

import { expect, it } from 'vitest'
import { UTC_ZONE } from '../../../../utils/timezone.ts'
import { encodeText } from '../../../../shell/bytes.ts'
import { FormatUsageError, GitError, UnparsableFormatError } from './errors.ts'
import {
  formatRefs,
  listingFormat,
  literalText,
  parseFormat,
  parseSortKeys,
  quoteText,
  renderRow,
  ValueTable,
  versioncmp,
  type FormatRefsOptions,
} from './ref_format.ts'
import {
  DateKind,
  QuoteStyle,
  RefKind,
  type RefContext,
  type RefItem,
  type RefObject,
} from './types.ts'

// Every expectation below is git's own output for the same refs, measured
// with git 2.47.3 and 2.50.1.
const ENC = new TextEncoder()

function commit(when: number, subject: string): RefObject {
  return {
    oid: String(when).padStart(40, '0'),
    type: 'commit',
    raw: ENC.encode(
      `tree ${'t'.repeat(40)}\nauthor A <a@x> ${String(when)} +0000\n` +
        `committer C <c@x> ${String(when)} +0000\n\n${subject}\n`,
    ),
  }
}

function ref(name: string, oid: string, kind: RefKind, obj: RefObject | null): RefItem {
  return { name, oid, kind, symref: null, obj, peeled: null, upstream: null, worktree: '' }
}

const BLOB: RefObject = { oid: 'b'.repeat(40), type: 'blob', raw: ENC.encode('x') }
const HEAD_A = ref('refs/heads/a', '1'.repeat(40), RefKind.BRANCH, commit(300, 'three'))
const TAG_BLOB = ref('refs/tags/blob', 'b'.repeat(40), RefKind.TAG, BLOB)
const ITEMS = [
  HEAD_A,
  ref('refs/heads/b', '2'.repeat(40), RefKind.BRANCH, commit(100, 'one')),
  TAG_BLOB,
  ref('refs/tags/c', '3'.repeat(40), RefKind.TAG, commit(300, 'tie')),
]
// Three refs dated within one day, so a short date ties them all.
const DATED = (
  [
    ['a10', 1300],
    ['a9', 1400],
    ['v2.0', 900],
  ] as const
).map(([n, when], i) =>
  ref(`refs/tags/${n}`, String(i).padStart(40, '0'), RefKind.TAG, commit(when, n)),
)
const CTX: RefContext = {
  known: new Set(),
  strict: true,
  head: null,
  headDescription: '',
  abbrev: 7,
  abbreviations: new Map(),
  mailmap: [],
  date: { kind: DateKind.NORMAL, local: false, strftime: '', now: 0, zone: UTC_ZONE },
  suffixes: [],
}

function run(
  template: string,
  keys: readonly string[] | null = ['refname'],
  options: FormatRefsOptions & { items?: RefItem[] } = {},
): [string, string | null] {
  const [out, stopped] = formatRefs(
    parseFormat(template),
    options.items ?? ITEMS,
    CTX,
    keys ? parseSortKeys(keys) : null,
    options,
  )
  return [out, stopped === null ? null : stopped.message]
}

it.each([
  ['100%%', '100%'],
  ['%41%4g', 'A%4g'],
  ['50% off', '50% off'],
  ['%', '%'],
  ['x%', 'x%'],
])('expands the percent escapes in %j', (text, expected) => {
  expect(literalText(text)).toBe(expected)
})

it('reads a hex escape as a raw byte', () => {
  expect(encodeText(literalText('%ff%00'))).toEqual(new Uint8Array([0xff, 0x00]))
})

it('never opens a field at a quoted percent', () => {
  expect(parseFormat('%%(refname)').pieces).toEqual(['%(refname)'])
  const pieces = parseFormat('%%%(refname)').pieces
  expect(pieces.map((p) => (typeof p === 'string' ? p : p.text))).toEqual(['%', 'refname'])
})

it('refuses an unclosed field with the usage or as a listing fatal', () => {
  expect(() => parseFormat('x %(refname')).toThrow(FormatUsageError)
  expect(() => parseFormat('x %(refname')).toThrow('malformed format string %(refname')
  expect(() => listingFormat('x %(refname')).toThrow(UnparsableFormatError)
})

it('refuses raw under a quoting that cannot carry bytes', () => {
  for (const spelling of ['raw', '*raw']) {
    expect(() => parseFormat(`%(${spelling})`, QuoteStyle.SHELL)).toThrow(
      new GitError(`--format=${spelling} cannot be used with --python, --shell, --tcl`),
    )
  }
  expect(parseFormat('%(raw)', QuoteStyle.PERL).pieces).toHaveLength(1)
  expect(parseFormat('%(raw:size)', QuoteStyle.SHELL).pieces).toHaveLength(1)
})

it('sorts by the last key given first', () => {
  const keys = parseSortKeys(['refname', '-v:objecttype', 'version:tag'])
  expect(keys.map((k) => [k.field.name, k.reverse, k.version])).toEqual([
    ['tag', false, true],
    ['objecttype', true, true],
    ['refname', false, false],
  ])
  expect(() => parseSortKeys(['v:-refname'])).toThrow(new GitError('unknown field name: -refname'))
})

it.each([
  [[], ['v1.0', 'v1.0-rc1', 'v1.0.1', 'v1.2', 'v1.10']],
  [['-rc'], ['v1.0-rc1', 'v1.0-rc2', 'v1.0', 'v1.0.1']],
  [
    ['-rc', '-beta'],
    ['v2.0-rc1', 'v2.0-beta', 'v2.0', 'v2.0.0'],
  ],
  [
    ['-rc', '0'],
    ['release-1.0', 'release-1.0-rc'],
  ],
  [
    ['-pre', '', '-post'],
    ['v1-pre', 'v1', 'v1-post'],
  ],
  [
    ['-rc', '-rc1'],
    ['v1.0-rc2', 'v1.0-rc1', 'v1.0'],
  ],
])('places the configured suffixes %j', (suffixes, names) => {
  for (let i = 0; i + 1 < names.length; i++) {
    expect(versioncmp(names[i] ?? '', names[i + 1] ?? '', suffixes)).toBeLessThan(0)
    expect(versioncmp(names[i + 1] ?? '', names[i] ?? '', suffixes)).toBeGreaterThan(0)
  }
})

it.each([
  [QuoteStyle.SHELL, "it's!!", "'it'\\''s'\\!''\\!''"],
  [QuoteStyle.PERL, "it's!\\", "'it\\'s!\\\\'"],
  [QuoteStyle.PYTHON, "it's!\\\n\t", "'it\\'s!\\\\\\n\t'"],
  [QuoteStyle.TCL, '[a]{b}$"\\\n\t\x01', '"\\[a\\]\\{b\\}\\$\\"\\\\\\n\\t\x01"'],
])('quotes for %s', (style, text, expected) => {
  expect(quoteText(text, style)).toBe(expected)
})

it('nests blocks and quotes them as a whole', () => {
  const fmt = parseFormat(
    '%(if:equals=blob)%(objecttype)%(then)[%(align:6,right)%(refname:lstrip=2)%(end)]%(else)%(subject)%(end)',
    QuoteStyle.SHELL,
  )
  expect(formatRefs(fmt, ITEMS.slice(1, 3), CTX, null)).toEqual(["'one'\n'[  blob]'\n", null])
})

it('takes a plain if as false on white space alone', () => {
  expect(run('%(if) %(then)y%(else)n%(end)', ['refname'], { items: ITEMS.slice(0, 1) })).toEqual([
    'n\n',
    null,
  ])
})

it('pads an align by display width', () => {
  const fmt = parseFormat(
    '%(align:6)Ærø%(end)|%(align:6,middle)日本%(end)|%(align:7,middle)ab%(end)|',
  )
  expect(renderRow(fmt, HEAD_A, new ValueTable([], CTX))).toBe('Ærø   | 日本 |  ab   |')
})

it.each([
  ['%(then)', 'format: %(then) atom used without a %(if) atom'],
  ['%(else)', 'format: %(else) atom used without a %(if) atom'],
  ['%(end)', 'format: %(end) atom used without corresponding atom'],
  ['%(if)', 'format: %(end) atom missing'],
  ['%(if)%(end)', 'format: %(if) atom used without a %(then) atom'],
  ['%(if)%(else)', 'format: %(else) atom used without a %(then) atom'],
  ['%(if)x%(then)y%(then)', 'format: %(then) atom used more than once'],
  ['%(if)x%(then)y%(else)z%(else)', 'format: %(else) atom used more than once'],
  ['%(if)a%(align:3)%(then)b%(end)%(end)', 'format: %(then) atom used without a %(if) atom'],
  ['%(align:3)%(if)a%(end)%(then)b%(end)', 'format: %(if) atom used without a %(then) atom'],
])('refuses blocks that do not nest in %j where a row renders', (template, message) => {
  expect(run(template)).toEqual(['', message])
  expect(run(template, ['refname'], { items: [] })).toEqual(['', null])
})

it('breaks ties by name upward whatever the direction', () => {
  expect(run('%(refname)', ['-committerdate'])[0]).toBe(
    'refs/heads/a\nrefs/tags/c\nrefs/heads/b\nrefs/tags/blob\n',
  )
})

it('compares a styled date key by instant only in the first comparison', () => {
  const items = DATED
  expect(run('%(refname:lstrip=2)', ['authordate:short'], { items })[0]).toBe('a10\nv2.0\na9\n')
  expect(run('%(refname:lstrip=2)', ['-authordate:short'], { items })[0]).toBe('a10\na9\nv2.0\n')
  expect(run('%(refname:lstrip=2)', ['authordate'], { items })[0]).toBe('v2.0\na10\na9\n')
})

it.each([
  [['authordate:short', 'authordate:short'], 'a10\nv2.0\na9\n'],
  [['authordate:short', 'committerdate:short'], 'a10\nv2.0\na9\n'],
  [['committerdate:short', 'v:authordate:short'], 'a10\na9\nv2.0\n'],
])("makes the first comparison the sort's whatever key makes it, for %j", (keys, expected) => {
  expect(run('%(refname:lstrip=2)', keys, { items: DATED })[0]).toBe(expected)
})

it('counts the empty row an omitted line leaves', () => {
  expect(
    run('%(if)%(subject)%(then)%(subject)%(end)', ['objectsize'], { count: 3, omitEmpty: true })[0],
  ).toBe('one\ntie\n')
})

it('stops a streamed listing where a field fails', () => {
  const items = [TAG_BLOB, HEAD_A]
  expect(run('%(refname) %(authordate:bogus)', ['refname'], { items })).toEqual([
    'refs/tags/blob \n',
    'unknown date format bogus',
  ])
  expect(run('%(refname) %(authordate:bogus)', ['refname'], { items, count: 1 })).toEqual([
    'refs/tags/blob \n',
    null,
  ])
})

it('refuses a field no comparison reads', () => {
  const refused = ['', 'unknown date format bogus']
  expect(run('%(refname)', ['authordate:bogus'], { items: ITEMS.slice(0, 1) })).toEqual(refused)
  expect(run('%(refname)', ['authordate:bogus', 'refname'], { items: ITEMS.slice(0, 2) })).toEqual(
    refused,
  )
  // A blob has no author date to refuse.
  expect(run('%(refname)', ['authordate:bogus'], { items: ITEMS.slice(2, 3) })).toEqual([
    'refs/tags/blob\n',
    null,
  ])
})

it('sorts even the default order under --ignore-case', () => {
  const items = ['B', 'a'].map((name) =>
    ref(`refs/heads/${name}`, '1'.repeat(40), RefKind.BRANCH, commit(1, 'x')),
  )
  expect(run('%(refname)', ['refname'], { items, count: 1 })).toEqual(['refs/heads/B\n', null])
  expect(run('%(refname)', ['refname'], { items, count: 1, icase: true })).toEqual([
    'refs/heads/a\n',
    null,
  ])
  // --no-sort keeps the order the refs came in.
  expect(run('%(refname)', null, { items, icase: true })).toEqual([
    'refs/heads/B\nrefs/heads/a\n',
    null,
  ])
})

it('renders every row of a sorted listing before it prints', () => {
  for (const count of [0, 1]) {
    const items = [HEAD_A, TAG_BLOB]
    expect(run('%(refname) %(authordate:bogus)', ['-refname'], { items, count })).toEqual([
      '',
      'unknown date format bogus',
    ])
  }
})

it('leads with a detached HEAD when asked', () => {
  const head = ref('HEAD', '1'.repeat(40), RefKind.DETACHED, commit(1, 'x'))
  const [out] = run('%(refname:short)', ['-refname'], {
    items: [...ITEMS.slice(0, 2), head],
    detachedFirst: true,
    stream: false,
  })
  expect(out.split('\n')[0]).toBe('')
})
