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
import {
  ebadfStdin,
  eisdir,
  enoent,
  enotdir,
} from './fs.ts'
import { formatFsError, fsErrorLine, revoiceFsErrorLine } from './render.ts'

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

describe('formatFsError', () => {
  it('prefixes a thrown command error with the command name (GNU prog: message)', () => {
    const line = decode(
      formatFsError(
        'slack-add-reaction',
        new Error('Slack API error (reactions.add): message_not_found'),
      ),
    )
    expect(line).toBe('slack-add-reaction: Slack API error (reactions.add): message_not_found\n')
  })

  it('stringifies a non-Error throw', () => {
    expect(decode(formatFsError('slack-add-reaction', 'boom'))).toBe('slack-add-reaction: boom\n')
  })

  it('does not double the prefix when the message already carries cmd:', () => {
    // Generic commands throw a fully GNU-formatted message (uniq: invalid
    // count); the prefix must not be doubled (uniq: uniq: ...).
    expect(decode(formatFsError('uniq', new Error("uniq: invalid count: '2junk'")))).toBe(
      "uniq: invalid count: '2junk'\n",
    )
  })

  it('renders a recognized filesystem error as cmd: path: strerror', () => {
    expect(decode(formatFsError('cat', enoent('/b/missing.txt')))).toBe(
      'cat: /b/missing.txt: No such file or directory\n',
    )
  })

  it('rewrites the resolved path to the as-typed spelling', () => {
    const line = decode(
      formatFsError('diff', enoent('/a/missing.txt'), [
        { virtual: '/a/missing.txt', rawPath: 'missing.txt' },
      ]),
    )
    expect(line).toBe('diff: missing.txt: No such file or directory\n')
  })
})

describe('fsErrorLine — commands that name the failed open', () => {
  const ENOENT = 'No such file or directory'

  it.each([
    ['head', `head: cannot open '/data/nope.txt' for reading: ${ENOENT}\n`],
    ['tail', `tail: cannot open '/data/nope.txt' for reading: ${ENOENT}\n`],
    ['fmt', `fmt: cannot open '/data/nope.txt' for reading: ${ENOENT}\n`],
    ['split', `split: cannot open '/data/nope.txt' for reading: ${ENOENT}\n`],
    ['csplit', `csplit: cannot open '/data/nope.txt' for reading: ${ENOENT}\n`],
    ['tac', `tac: failed to open '/data/nope.txt' for reading: ${ENOENT}\n`],
    ['truncate', `truncate: cannot open '/data/nope.txt' for writing: ${ENOENT}\n`],
    ['stat', `stat: cannot statx '/data/nope.txt': ${ENOENT}\n`],
    ['sed', `sed: can't read /data/nope.txt: ${ENOENT}\n`],
    ['uniq', `uniq: /data/nope.txt: ${ENOENT}\n`],
  ])('%s reports a missing operand as a failed open', (cmd, line) => {
    expect(fsErrorLine(cmd, '/data/nope.txt', enoent('/data/nope.txt'))).toBe(line)
  })

  // GNU's own fmt and base64 lines (`fmt: read error`, `base64: read error:
  // Is a directory`) name no operand, so those keep the plain one.
  it.each([
    ['head', "head: error reading '/data/sub': Is a directory\n"],
    ['tail', "tail: error reading '/data/sub': Is a directory\n"],
    ['uniq', "uniq: error reading '/data/sub': Is a directory\n"],
    ['tac', 'tac: /data/sub: read error: Is a directory\n'],
    ['tsort', 'tsort: /data/sub: read error: Is a directory\n'],
    ['sed', 'sed: read error on /data/sub: Is a directory\n'],
    ['truncate', "truncate: cannot open '/data/sub' for writing: Is a directory\n"],
    ['fmt', 'fmt: /data/sub: Is a directory\n'],
    ['base64', 'base64: /data/sub: Is a directory\n'],
  ])('%s reports a directory as a failed read', (cmd, line) => {
    expect(fsErrorLine(cmd, '/data/sub', eisdir('/data/sub'))).toBe(line)
  })

  it.each([
    ['head', `head: cannot open "it's.txt" for reading: ${ENOENT}\n`],
    ['stat', `stat: cannot statx "it's.txt": ${ENOENT}\n`],
    ['sed', `sed: can't read it's.txt: ${ENOENT}\n`],
  ])('%s quotes the operand as typed', (cmd, line) => {
    const spec = { virtual: "/data/it's.txt", rawPath: "it's.txt" }
    expect(fsErrorLine(cmd, spec, enoent(spec))).toBe(line)
  })

  // A line that is cat's own for the operand is said again from its
  // strerror; one about another path only has its prefix swapped.
  it.each([
    [
      'cat: /b/nope: No such file or directory',
      "sed: can't read /b/nope: No such file or directory",
    ],
    ["cat: '/b/a b': Is a directory", 'sed: read error on /b/a b: Is a directory'],
    ['cat: /b/other: No such file or directory', 'sed: /b/other: No such file or directory'],
    ['unrelated', 'unrelated'],
  ])('revoices %j in the real command voice', (line, said) => {
    const operand = line.includes('a b') ? '/b/a b' : '/b/nope'
    expect(revoiceFsErrorLine(line, 'cat', 'sed', operand)).toBe(said)
  })

  it('leaves standard input bare', () => {
    expect(fsErrorLine('tail', '-', ebadfStdin())).toBe('tail: -: Bad file descriptor\n')
  })

  it('words a head open failure at the chokepoint', () => {
    expect(decode(formatFsError('head', enoent('/a/gone.txt')))).toBe(
      "head: cannot open '/a/gone.txt' for reading: No such file or directory\n",
    )
  })

  it.each([
    ['tac', "failed to open '/data/a.txt/x' for reading"],
    ['stat', "cannot statx '/data/a.txt/x'"],
    ['truncate', "cannot open '/data/a.txt/x' for writing"],
  ])('%s names its own failed step', (cmd, step) => {
    // The errno is the backend's either way; only the step and the quoting
    // are the command's (coreutils 9.7).
    expect(fsErrorLine(cmd, '/data/a.txt/x', enoent('/data/a.txt/x'))).toBe(
      `${cmd}: ${step}: No such file or directory\n`,
    )
    expect(fsErrorLine(cmd, '/data/a.txt/x', enotdir('/data/a.txt/x'))).toBe(
      `${cmd}: ${step}: Not a directory\n`,
    )
  })

  it('names a tac directory read first and quotes it only when needed', () => {
    // tac's read failure leads with the name, which GNU quotes the way
    // quotef does: only a name that needs it, ':' included.
    expect(fsErrorLine('tac', '/data/sub', eisdir('/data/sub'))).toBe(
      'tac: /data/sub: read error: Is a directory\n',
    )
    expect(fsErrorLine('tac', '/data/a b', eisdir('/data/a b'))).toBe(
      "tac: '/data/a b': read error: Is a directory\n",
    )
    expect(fsErrorLine('tac', '/data/c:d', eisdir('/data/c:d'))).toBe(
      "tac: '/data/c:d': read error: Is a directory\n",
    )
  })

  it('says one step for a stat or truncate directory', () => {
    expect(fsErrorLine('truncate', '/data/sub', eisdir('/data/sub'))).toBe(
      "truncate: cannot open '/data/sub' for writing: Is a directory\n",
    )
    expect(fsErrorLine('stat', '/data/sub', eisdir('/data/sub'))).toBe(
      "stat: cannot statx '/data/sub': Is a directory\n",
    )
  })

  it('escapes a control character in a step line', () => {
    expect(fsErrorLine('stat', '/data/a\tb', enoent('/data/a\tb'))).toBe(
      "stat: cannot statx '/data/a'$'\\t''b': No such file or directory\n",
    )
  })

  it('leaves tac standard input bare', () => {
    expect(fsErrorLine('tac', '-', ebadfStdin())).toBe('tac: -: Bad file descriptor\n')
  })

  it('names an empty operand as typed', () => {
    // An empty rawPath is the operand as typed, not a missing one; the
    // Python formatter reads it the same way.
    const spec = { virtual: '/data', rawPath: '' }
    expect(fsErrorLine('tac', spec, enoent(spec))).toBe(
      "tac: failed to open '' for reading: No such file or directory\n",
    )
    expect(fsErrorLine('cat', spec, enoent(spec))).toBe("cat: '': No such file or directory\n")
  })

  it('words a stat failure at the chokepoint', () => {
    expect(decode(formatFsError('stat', enoent('/a/gone.txt')))).toBe(
      "stat: cannot statx '/a/gone.txt': No such file or directory\n",
    )
  })
})
