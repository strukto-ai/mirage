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

import { describe, expect, it } from 'vitest'
import { UTC_ZONE } from '../../../../utils/timezone.ts'
import { GitError, UnknownDateFormatError, UnsupportedFieldError } from './errors.ts'
import {
  abbreviationRequests,
  cInt,
  cUint,
  fieldValue,
  lstripRef,
  messageParts,
  parseField,
  rstripRef,
  sanitizeSubject,
  shortenRef,
} from './ref_fields.ts'
import {
  DateKind,
  RefKind,
  type RefContext,
  type RefItem,
  type RefObject,
  type RefUpstream,
} from './types.ts'

// Every expectation below is git's own output for the same objects, measured
// with git 2.47.3 and 2.50.1.
const ENC = new TextEncoder()
const COMMIT: RefObject = {
  oid: 'c'.repeat(40),
  type: 'commit',
  raw: ENC.encode(
    `tree ${'t'.repeat(40)}\nparent ${'p'.repeat(40)}\n` +
      'author A U Thor <author@example.com> 1584244800 +0530\n' +
      'committer C O Mitter <committer@example.com> 1584381600 -0800\n' +
      '\nSubject line\nwraps\n\nBody one.\nBody two.\n',
  ),
}
const TAG: RefObject = {
  oid: 'a'.repeat(40),
  type: 'tag',
  raw: ENC.encode(
    `object ${'c'.repeat(40)}\ntype commit\ntag v1\n` +
      'tagger T Agger <tagger@example.com> 1600000000 +0000\n\n' +
      'Release notes\n\nMore.\n-----BEGIN PGP SIGNATURE-----\nsig\n' +
      '-----END PGP SIGNATURE-----\n',
  ),
}
const BLOB: RefObject = { oid: 'b'.repeat(40), type: 'blob', raw: ENC.encode('data\n') }
const CTX: RefContext = {
  known: new Set(['refs/heads/main', 'refs/tags/main']),
  strict: true,
  head: 'refs/heads/main',
  headDescription: '',
  abbrev: 7,
  abbreviations: new Map(),
  mailmap: [],
  date: { kind: DateKind.NORMAL, local: false, strftime: '', now: 1700000000, zone: UTC_ZONE },
  suffixes: [],
}

function item(
  obj: RefObject | null,
  name = 'refs/heads/main',
  extra: Partial<RefItem> = {},
): RefItem {
  return {
    name,
    oid: obj?.oid ?? '0'.repeat(40),
    kind: name.startsWith('refs/tags/') ? RefKind.TAG : RefKind.BRANCH,
    symref: null,
    obj,
    peeled: null,
    upstream: null,
    worktree: '',
    ...extra,
  }
}

function value(
  name: string,
  obj: RefObject | null = COMMIT,
  ref = 'refs/heads/main',
  extra: Partial<RefItem> = {},
  ctx: RefContext = CTX,
): string {
  return fieldValue(parseField(name), item(obj, ref, extra), ctx).text
}

describe('parseField', () => {
  it.each([
    ['', 'malformed field name: '],
    ['*', 'malformed field name: *'],
    [':x', 'unknown field name: :x'],
    ['bogus:x', 'unknown field name: bogus:x'],
    ['**refname', 'unknown field name: **refname'],
    ['creatorname', 'unknown field name: creatorname'],
    ['refname:bogus', 'unrecognized %(refname) argument: bogus'],
    ['*refname:bogus', 'unrecognized %(*refname) argument: bogus'],
    ['*tree:x', 'unrecognized %(*tree) argument: x'],
    ['*authoremail:x', 'unrecognized %(*authoremail) argument: x'],
    ['*subject:x', 'unrecognized %(subject) argument: x'],
    ['*objecttype:x', '%(objecttype) does not take arguments'],
    ['body:x', '%(body) does not take arguments'],
    ['refname:lstrip=x', 'Integer value expected refname:lstrip=x'],
    ['symref:strip=x', 'Integer value expected refname:lstrip=x'],
    ['upstream:rstrip=1 ', 'Integer value expected refname:rstrip=1 '],
    ['objectname:short=0', "positive value expected '0' in %(objectname:short=0)"],
    ['*objectname:short=-1', "positive value expected '-1' in %(*objectname:short=-1)"],
    ['contents:lines=x', 'positive value expected contents:lines=x'],
    ['authoremail:trimfoo', 'unrecognized %(authoremail) argument: foo'],
    ['authoremail:trim,', 'unrecognized %(authoremail) argument: '],
    ['authoremail:,trim', 'unrecognized %(authoremail) argument: ,trim'],
    ['authorname:mailmap,x', 'unrecognized %(authorname) argument: mailmap,x'],
    ['upstream:short,track', 'unrecognized %(upstream) argument: short,track'],
    ['upstream:track,', 'unrecognized %(upstream) argument: track,'],
    ['align', 'expected format: %(align:<width>,<position>)'],
    ['align:left', 'positive width expected with the %(align) atom'],
    ['align:5,up', 'unrecognized %(align) argument: up'],
    ['align:position=up,5', 'unrecognized position:up'],
    ['align:width=-1', 'unrecognized width:-1'],
    ['align:5,', 'unrecognized %(align) argument: '],
    ['if:equals', 'unrecognized %(if) argument: equals'],
    ['rest', 'this command reject atom %(rest)'],
    ['rest:', 'this command reject atom %(rest:)'],
    ['rest:x', '%(rest) does not take arguments'],
    ['deltabase:short', '%(deltabase) does not take arguments'],
    ['is-base', 'expected format: %(is-base:<committish>)'],
    ['color', 'expected format: %(color:<color>)'],
  ])('refuses %j in git words', (name, message) => {
    expect(() => parseField(name)).toThrow(new GitError(message))
  })

  it.each([
    'describe',
    'trailers',
    'contents:trailers',
    'push',
    'color:red',
    'objectsize:disk',
    'flag',
  ])('calls %s unsupported rather than unknown', (name) => {
    expect(() => parseField(name)).toThrow(UnsupportedFieldError)
  })
})

it.each([
  ['2', 2],
  [' +3', 3],
  ['-4', -4],
  ['', null],
  ['2 ', null],
  ['0x1', null],
  ['2147483648', null],
])('cInt reads %j as a 32-bit integer', (text, expected) => {
  expect(cInt(text)).toBe(expected)
})

it.each([
  ['7', 7],
  [' +7', 7],
  ['-7', null],
  ['7x', null],
  ['2147483648', -2147483648],
  ['4294967296', null],
])('cUint wraps %j past 31 bits and refuses a minus', (text, expected) => {
  expect(cUint(text)).toBe(expected)
})

it.each([
  ['refs/heads/main', 'heads/main'],
  ['refs/tags/main', 'tags/main'],
  ['refs/remotes/origin/HEAD', 'origin'],
  ['refs/remotes/origin/main', 'origin/main'],
  ['refs/notes/commits', 'notes/commits'],
  ['refs/heads/HEAD', 'heads/HEAD'],
  ['HEAD', 'HEAD'],
])('shortens %s to what still names it', (name, expected) => {
  expect(shortenRef(name, new Set(['HEAD', 'refs/heads/main', 'refs/tags/main']))).toBe(expected)
})

it('checks only earlier rules when loose', () => {
  const known = new Set(['refs/heads/main', 'refs/tags/main'])
  expect(shortenRef('refs/tags/main', known, false)).toBe('main')
  expect(shortenRef('refs/heads/main', known, false)).toBe('heads/main')
})

it.each([
  [0, 'refs/heads/feat/x', 'refs/heads/feat/x'],
  [1, 'heads/feat/x', 'refs/heads/feat'],
  [4, '', ''],
  [-1, 'x', 'refs'],
  [-3, 'heads/feat/x', 'refs/heads/feat'],
  [-9, 'refs/heads/feat/x', 'refs/heads/feat/x'],
])('strips %i components from either end', (count, left, right) => {
  expect(lstripRef('refs/heads/feat/x', count)).toBe(left)
  expect(rstripRef('refs/heads/feat/x', count)).toBe(right)
})

it.each([
  ['\n\nlead\n\nbody\n', 'lead', 'body\n', ''],
  ['a\n \nb\n\nc\n', 'a   b', 'c\n', ''],
  ['subj\r\nwith crlf\r\n\r\nbody\r\n', 'subj with crlf', 'body\r\n', ''],
  [
    's\nmore\n-----BEGIN PGP SIGNATURE-----\nx\n',
    's more',
    '',
    '-----BEGIN PGP SIGNATURE-----\nx\n',
  ],
  [
    's\n\n-----BEGIN PGP SIGNATURE-----\nfirst\n-----BEGIN SSH SIGNATURE-----\nsecond\n',
    's',
    '-----BEGIN PGP SIGNATURE-----\nfirst\n',
    '-----BEGIN SSH SIGNATURE-----\nsecond\n',
  ],
  [
    's\n\nbody\n -----BEGIN PGP SIGNATURE-----\n',
    's',
    'body\n -----BEGIN PGP SIGNATURE-----\n',
    '',
  ],
])('splits %j into subject, body and its last signature', (message, subject, body, signature) => {
  const [, found, bodyAt, sig] = messageParts(message)
  expect([found, message.slice(bodyAt, sig), message.slice(sig)]).toEqual([
    subject,
    body,
    signature,
  ])
})

it.each([
  ['Fix: the \'quoted\' "thing" -- now (really) [done]!', 'Fix-the-quoted-thing-now-really-done'],
  ['../..//weird...name...', '.-.-weird.name'],
  ['-dashes- -in- -places-', 'dashes-in-places'],
  ['unicode Ærø 日本 ü', 'unicode-r'],
  ['a . .', 'a'],
  ['._.', '._'],
  ['x.lock', 'x.lock'],
  ['a. .b', 'a.-.b'],
])('sanitizes %j to its title characters', (subject, expected) => {
  expect(sanitizeSubject(subject)).toBe(expected)
})

it.each([
  ['subject', 'Subject line wraps'],
  ['subject:sanitize', 'Subject-line-wraps'],
  ['body', 'Body one.\nBody two.\n'],
  ['body:', ''],
  ['contents:lines=2', 'Subject line\n    wraps'],
  ['contents:size', '40'],
  ['author', 'A U Thor <author@example.com> 1584244800 +0530'],
  ['author:mailmap', ''],
  ['creator:x', 'C O Mitter <committer@example.com> 1584381600 -0800'],
  ['authorname', 'A U Thor'],
  ['authoremail:trim', 'author@example.com'],
  ['authoremail:localpart', 'author'],
  ['authordate', 'Sun Mar 15 09:30:00 2020 +0530'],
  ['authordate:short', '2020-03-15'],
  ['tree:short', 'ttttttt'],
  ['parent:short=4', 'pppp'],
  ['numparent', '1'],
  ['tagger', ''],
  ['*objectname', ''],
  ['*refname', 'refs/heads/main^{}'],
  ['*symref', '^{}'],
  ['*HEAD', '*'],
  ['refname:short', 'heads/main'],
])('reads %s off a commit', (name, expected) => {
  expect(value(name)).toBe(expected)
})

it.each([
  ['tag', 'v1'],
  ['type', 'commit'],
  ['object', 'c'.repeat(40)],
  ['taggername', 'T Agger'],
  ['creatordate:iso', '2020-09-13 12:26:40 +0000'],
  ['body', 'More.\n-----BEGIN PGP SIGNATURE-----\nsig\n-----END PGP SIGNATURE-----\n'],
  ['contents:body', 'More.\n'],
  ['contents:signature', '-----BEGIN PGP SIGNATURE-----\nsig\n-----END PGP SIGNATURE-----\n'],
  ['contents:lines=9', 'Release notes\n    \n    More.'],
  ['authorname', ''],
  ['*objectname', 'c'.repeat(40)],
  ['*subject', 'Subject line wraps'],
])('reads %s off a tag and what it peels to', (name, expected) => {
  expect(value(name, TAG, 'refs/tags/v1', { peeled: COMMIT })).toBe(expected)
})

it.each([
  [' Spaced  Name  <s@x> 1 +0100', ' Spaced  Name ', '<s@x>', '1 +0100'],
  ['Name<n@x>1 +0000', '', '<n@x>', ''],
  ['<only@x> 1 +0000', '', '<only@x>', '1 +0000'],
  ['Name <n@x>', 'Name', '<n@x>', ''],
])('splits the identity %j as git reads it', (ident, name, email, date) => {
  const tag: RefObject = {
    oid: 'd'.repeat(40),
    type: 'tag',
    raw: ENC.encode(`object ${'c'.repeat(40)}\ntype commit\ntag t\ntagger ${ident}\n\nm\n`),
  }
  const shown = ['taggername', 'taggeremail', 'taggerdate:raw'].map((f) =>
    value(f, tag, 'refs/tags/t'),
  )
  expect(shown).toEqual([name, email, date])
})

it('checks a date style wherever the person line is', () => {
  expect(value('authordate:bogus', BLOB)).toBe('')
  expect(value('authordate:bogus', TAG, 'refs/tags/v1')).toBe('')
  expect(() => value('authordate:bogus')).toThrow(UnknownDateFormatError)
  const undated: RefObject = {
    oid: 'd'.repeat(40),
    type: 'tag',
    raw: ENC.encode('object x\ntype commit\ntag t\ntagger N <n@x>\n\nm\n'),
  }
  expect(() => value('taggerdate:bogus', undated, 'refs/tags/t')).toThrow(UnknownDateFormatError)
})

it('maps the identity under the mailmap options', () => {
  const ctx: RefContext = {
    ...CTX,
    mailmap: [{ email: 'author@example.com', name: null, mappedName: 'Alice', mappedEmail: null }],
  }
  expect(value('authorname:mailmap', COMMIT, 'refs/heads/main', {}, ctx)).toBe('Alice')
  expect(value('authorname', COMMIT, 'refs/heads/main', {}, ctx)).toBe('A U Thor')
  expect(value('authoremail:mailmap,trim', COMMIT, 'refs/heads/main', {}, ctx)).toBe(
    'author@example.com',
  )
})

describe('upstream', () => {
  const up: RefUpstream = {
    ref: 'refs/remotes/origin/main',
    remote: 'origin',
    merge: 'refs/heads/main',
    ahead: 1,
    behind: 2,
    gone: false,
  }
  it.each([
    ['upstream', 'refs/remotes/origin/main'],
    ['upstream:short', 'origin/main'],
    ['upstream:lstrip=-1', 'main'],
    ['upstream:track', '[ahead 1, behind 2]'],
    ['upstream:track,nobracket', 'ahead 1, behind 2'],
    ['upstream:nobracket', 'refs/remotes/origin/main'],
    ['upstream:trackshort', '<>'],
    ['upstream:remotename,remoteref', 'refs/heads/main'],
    ['*upstream', 'refs/remotes/origin/main'],
  ])('reads %s on a branch only', (name, expected) => {
    expect(value(name, COMMIT, 'refs/heads/main', { upstream: up })).toBe(expected)
    expect(value(name, COMMIT, 'refs/tags/main', { upstream: up })).toBe('')
  })

  it('tracks a gone upstream as gone', () => {
    const gone = { ...up, ahead: 0, behind: 0, gone: true }
    expect(value('upstream:track', COMMIT, 'refs/heads/main', { upstream: gone })).toBe('[gone]')
    expect(value('upstream:trackshort', COMMIT, 'refs/heads/main', { upstream: gone })).toBe('')
  })
})

it('widens collisions but keeps longer requested widths', () => {
  const row = item(TAG, 'refs/tags/v1', { peeled: COMMIT })
  const ctx = { ...CTX, abbreviations: new Map([[COMMIT.oid, 8]]) }
  for (const [suffix, width] of [
    ['', 40],
    [':short', 8],
    [':short=4', 8],
    [':short=12', 12],
    [':short=2147483648', 8],
  ] as const) {
    expect(fieldValue(parseField(`*objectname${suffix}`), row, ctx).text).toBe(
      COMMIT.oid.slice(0, width),
    )
  }
})

it('requests each id at its narrowest width', () => {
  const row = item(TAG, 'refs/tags/v1', { peeled: COMMIT })
  const fields = [
    'objectname',
    '*objectname:short=12',
    '*objectname:short=3',
    '*parent:short',
    '*tree:short=40',
  ].map(parseField)
  expect(abbreviationRequests(fields, [row, row], CTX)).toEqual(
    new Map([
      [COMMIT.oid, 4],
      ['p'.repeat(40), 7],
      ['t'.repeat(40), 40],
    ]),
  )
})

it('names a detached HEAD row by its description', () => {
  const head = { ...item(COMMIT, 'HEAD'), kind: RefKind.DETACHED }
  const ctx = { ...CTX, head: 'HEAD', headDescription: '(HEAD detached at ccccccc)' }
  for (const name of ['refname', 'refname:short', 'refname:lstrip=1']) {
    expect(fieldValue(parseField(name), head, ctx).text).toBe('(HEAD detached at ccccccc)')
  }
  expect(fieldValue(parseField('HEAD'), head, ctx).text).toBe('*')
})
