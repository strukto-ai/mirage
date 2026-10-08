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
import { encodeText } from '../../../../shell/bytes.ts'
import { FormatUsageError, GitError, UnparsableFormatError } from './errors.ts'
import {
  formatRefs,
  listingFormat,
  literalText,
  parseFormat,
  parseSortKeys,
  quoteText,
  versioncmp,
  type ListingOptions,
} from './ref_format.ts'
import {
  DateKind,
  QuoteStyle,
  RefKind,
  type RefContext,
  type RefItem,
  type RefObject,
} from './types.ts'

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

function ref(name: string, kind: RefKind, obj: RefObject): RefItem {
  return { name, oid: obj.oid, kind, symref: null, obj, peeled: null, upstream: null, worktree: '' }
}

const BLOB: RefObject = { oid: 'b'.repeat(40), type: 'blob', raw: ENC.encode('x') }
const A = ref('refs/heads/a', RefKind.BRANCH, commit(300, 'three'))
const B = ref('refs/heads/b', RefKind.BRANCH, commit(100, 'one'))
const BLOB_TAG = ref('refs/tags/blob', RefKind.TAG, BLOB)
const C = ref('refs/tags/c', RefKind.TAG, commit(300, 'tie'))
const ITEMS = [A, B, BLOB_TAG, C]
const CTX: RefContext = {
  known: new Set(),
  strict: true,
  head: null,
  headDescription: '',
  abbrev: 7,
  abbreviations: new Map(),
  mailmap: [],
  date: { kind: DateKind.NORMAL, local: false, strftime: '', now: 0, zone: null },
  suffixes: [],
}

function run(
  template: string,
  keys: readonly string[] | null = ['refname'],
  items: readonly RefItem[] = ITEMS,
  options: ListingOptions = {},
): [string, string | null] {
  const [out, stopped] = formatRefs(
    parseFormat(template),
    items,
    CTX,
    keys ? parseSortKeys(keys) : null,
    options,
  )
  return [out, stopped === null ? null : stopped.message]
}

it.each(['refname:short', 'refname:lstrip=2'])(
  'sorts transformed names by %s before applying count',
  (key) => {
    const items = [
      { ...A, name: 'refs/heads/main' },
      { ...C, name: 'refs/tags/base' },
    ]
    expect(run('%(refname)', ['refname', key], items, { count: 1 })).toEqual([
      'refs/tags/base\n',
      null,
    ])
    expect(run('%(refname)', [key], items, { count: 1 })).toEqual(['refs/heads/main\n', null])
  },
)

it.each([
  ['100%%', '100%'],
  ['%41%2x', 'A%2x'],
  ['50% off', '50% off'],
  ['%', '%'],
])('expands the percent escapes in %j', (text, expected) => {
  expect(literalText(text)).toBe(expected)
})

it('names a raw byte with a hex escape', () => {
  expect([...encodeText(literalText('%ff%00'))]).toEqual([0xff, 0x00])
})

it('never opens a field at a quoted percent', () => {
  expect(parseFormat('%%(refname)').pieces).toEqual(['%(refname)'])
})

it('refuses an unclosed field as a usage error, or a listing fatal', () => {
  expect(() => parseFormat('x %(refname')).toThrow(FormatUsageError)
  expect(() => parseFormat('x %(refname')).toThrow('malformed format string %(refname')
  expect(() => listingFormat('x %(refname')).toThrow(UnparsableFormatError)
  expect(() => listingFormat('x %(refname')).toThrow(
    'malformed format string %(refname\nfatal: unable to parse format string',
  )
})

it('refuses rest, and a bare raw under a text quote', () => {
  expect(() => parseFormat('%(rest)')).toThrow('this command reject atom %(rest)')
  expect(() => parseFormat('%(raw)', QuoteStyle.SHELL)).toThrow(
    '--format=raw cannot be used with --python, --shell, --tcl',
  )
  expect(parseFormat('%(raw)', QuoteStyle.PERL).pieces.length).toBe(1)
})

it('sorts by the last key given first', () => {
  const keys = parseSortKeys(['refname', '-v:objecttype', 'version:tag'])
  expect(keys.map((k) => [k.field.name, k.reverse, k.version])).toEqual([
    ['tag', false, true],
    ['objecttype', true, true],
    ['refname', false, false],
  ])
})

it('sorts a prerelease suffix before its release', () => {
  expect(versioncmp('v2.0-rc1', 'v2.0', ['-rc'])).toBeLessThan(0)
  expect(versioncmp('v2.0', 'v2.0-rc1', ['-rc'])).toBeGreaterThan(0)
})

it.each([
  [QuoteStyle.SHELL, "it's!!", "'it'\\''s'\\!''\\!''"],
  [QuoteStyle.PERL, "it's!\\", "'it\\'s!\\\\'"],
  [QuoteStyle.PYTHON, "it's!\\\n", "'it\\'s!\\\\\\n'"],
  [QuoteStyle.TCL, "it's!\\\n$", '"it\'s!\\\\\\n\\$"'],
])('quotes for %s', (style, text, expected) => {
  expect(quoteText(text, style)).toBe(expected)
})

it('breaks ties by name, unreversed', () => {
  expect(run('%(refname)', ['-committerdate'])[0]).toBe(
    'refs/heads/a\nrefs/tags/c\nrefs/heads/b\nrefs/tags/blob\n',
  )
})

it('counts the rows it omits as empty', () => {
  const [out] = run('%(if)%(subject)%(then)%(subject)%(end)', ['objectsize'], ITEMS, {
    count: 3,
    omitEmpty: true,
  })
  expect(out).toBe('one\ntie\n')
})

it('nests blocks and quotes them whole', () => {
  const fmt = parseFormat(
    '%(if:equals=blob)%(objecttype)%(then)[%(align:6,right)%(refname:lstrip=2)%(end)]' +
      '%(else)%(subject)%(end)',
    QuoteStyle.SHELL,
  )
  expect(formatRefs(fmt, [B, BLOB_TAG], CTX, null)[0]).toBe("'one'\n'[  blob]'\n")
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
  ['%(if)x%(then)y%(else)z%(then)', 'format: %(then) atom used more than once'],
])('refuses %s', (template, message) => {
  expect(run(template)).toEqual(['', message])
})

it('stops a streamed listing where a field fails', () => {
  expect(run('%(refname) %(authordate:bogus)', ['refname'], [BLOB_TAG, A])).toEqual([
    'refs/tags/blob \n',
    'unknown date format bogus',
  ])
})

it('fails a sorted listing before it prints', () => {
  expect(run('%(refname) %(authordate:bogus)', ['-refname'], [BLOB_TAG, A])).toEqual([
    '',
    'unknown date format bogus',
  ])
})

it('puts a detached HEAD first when asked', () => {
  const head = ref('HEAD', RefKind.DETACHED, commit(1, 'x'))
  const [out] = run('%(refname)', ['-refname'], [A, B, head], {
    detachedFirst: true,
    stream: false,
  })
  expect(out.split('\n')[0]).toBe('')
})

it('keeps GitError the only refusal', () => {
  expect(new UnparsableFormatError('x')).toBeInstanceOf(GitError)
})
