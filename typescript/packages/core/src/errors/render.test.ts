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
  dotWalkError,
  ebadf,
  efbig,
  eisdir,
  enoent,
  enotdir,
  enotempty,
  enotsup,
  exdev,
  fsStrerror,
} from './fs.ts'
import { formatFsError, fsErrorLine, revoiceFsErrorLine } from './render.ts'
import { CycleError } from '../utils/path.ts'

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)
const ENOENT = 'No such file or directory'
const NOPE = '/data/nope.txt'
const SUB = '/data/sub'
const FILE = '/data/a.txt/x'
const QUOTED = { virtual: "/data/it's.txt", rawPath: "it's.txt" }
const EMPTY = { virtual: '/data', rawPath: '' }

describe('fsErrorLine', () => {
  // The errno is the backend's; the step and the quoting are the command's.
  // The reference fmt and base64 read lines name no operand, so those keep
  // the plain one; an empty rawPath is the operand as typed, not the path it
  // resolved to.
  it.each([
    ['head', NOPE, enoent, `cannot open '${NOPE}' for reading`],
    ['tail', NOPE, enoent, `cannot open '${NOPE}' for reading`],
    ['fmt', NOPE, enoent, `cannot open '${NOPE}' for reading`],
    ['split', NOPE, enoent, `cannot open '${NOPE}' for reading`],
    ['csplit', NOPE, enoent, `cannot open '${NOPE}' for reading`],
    ['tac', NOPE, enoent, `failed to open '${NOPE}' for reading`],
    ['truncate', NOPE, enoent, `cannot open '${NOPE}' for writing`],
    ['stat', NOPE, enoent, `cannot statx '${NOPE}'`],
    ['sed', NOPE, enoent, `can't read ${NOPE}`],
    ['uniq', NOPE, enoent, NOPE],
    ['head', QUOTED, enoent, `cannot open "it's.txt" for reading`],
    ['stat', QUOTED, enoent, `cannot statx "it's.txt"`],
    ['sed', QUOTED, enoent, "can't read it's.txt"],
    ['stat', '/data/a\tb', enoent, "cannot statx '/data/a'$'\\t''b'"],
    ['tail', '', enoent, "cannot open '' for reading"],
    ['tac', EMPTY, enoent, "failed to open '' for reading"],
    ['cat', EMPTY, enoent, "''"],
    ['head', SUB, eisdir, `error reading '${SUB}'`],
    ['tail', SUB, eisdir, `error reading '${SUB}'`],
    ['uniq', SUB, eisdir, `error reading '${SUB}'`],
    ['tac', SUB, eisdir, `${SUB}: read error`],
    ['tac', '/data/a b', eisdir, "'/data/a b': read error"],
    ['tac', '/data/c:d', eisdir, "'/data/c:d': read error"],
    ['tsort', SUB, eisdir, `${SUB}: read error`],
    ['sed', SUB, eisdir, `read error on ${SUB}`],
    ['truncate', SUB, eisdir, `cannot open '${SUB}' for writing`],
    ['stat', SUB, eisdir, `cannot statx '${SUB}'`],
    ['fmt', SUB, eisdir, SUB],
    ['base64', SUB, eisdir, SUB],
    ['tac', FILE, enotdir, `failed to open '${FILE}' for reading`],
    ['stat', FILE, enotdir, `cannot statx '${FILE}'`],
    ['truncate', FILE, enotdir, `cannot open '${FILE}' for writing`],
    ['tail', '-', ebadf, '-'],
    ['tac', '-', ebadf, '-'],
  ] as const)('%s names its own failed step (%#)', (cmd, operand, make, step) => {
    const err = make(operand)
    expect(fsErrorLine(cmd, operand, err)).toBe(`${cmd}: ${step}: ${String(fsStrerror(err))}\n`)
  })

  it.each(['wc', 'du'])('%s vets the empty name', (cmd) => {
    expect(fsErrorLine(cmd, '', enoent(''))).toBe(`${cmd}: invalid zero-length file name\n`)
  })
})

describe('formatFsError', () => {
  // A filesystem error is the operand's line; anything else is the
  // command's prefix and the error's own words, never doubled.
  it.each([
    ['cat', enoent('/b/x'), `/b/x: ${ENOENT}`],
    ['ls', enoent('/b/x'), `cannot access '/b/x': ${ENOENT}`],
    ['head', enoent('/b/x'), `cannot open '/b/x' for reading: ${ENOENT}`],
    ['stat', enoent('/b/x'), `cannot statx '/b/x': ${ENOENT}`],
    ['cat', dotWalkError('', 'ENOENT'), `'': ${ENOENT}`],
    ['mv', enotsup('email', 'unlink', '/m'), '/m: Operation not supported'],
    ['cat', efbig('/r'), '/r: File too large'],
    ['head', efbig('/r'), "error reading '/r': File too large"],
    ['tail', efbig('/r'), "error reading '/r': File too large"],
    ['rmdir', enotempty('/d'), "failed to remove '/d': Directory not empty"],
    ['mv', exdev('/d'), '/d: Invalid cross-device link'],
    ['cat', new CycleError('/l'), '/l: Too many levels of symbolic links'],
    ['slack', new Error('API error'), 'API error'],
    ['slack', 'boom', 'boom'],
    ['uniq', new Error("uniq: invalid count: '2'"), "invalid count: '2'"],
  ])('%s says %j', (cmd, err, words) => {
    expect(decode(formatFsError(cmd, err))).toBe(`${cmd}: ${words}\n`)
  })

  it('spells the operand the caller passes', () => {
    const typed = [{ virtual: '/a/x.txt', rawPath: 'x.txt' }]
    expect(decode(formatFsError('diff', enoent('/a/x.txt'), typed))).toBe(
      `diff: x.txt: ${ENOENT}\n`,
    )
  })
})

describe('revoiceFsErrorLine', () => {
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
})
