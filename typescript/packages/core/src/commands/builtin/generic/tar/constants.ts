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

import type { CompressionKind } from './types.ts'

export const COMPRESSION_SIGNATURES: Readonly<Record<CompressionKind, readonly number[]>> =
  Object.freeze({
    gzip: [0x1f, 0x8b],
    bzip2: [0x42, 0x5a, 0x68],
    xz: [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00],
  })

// Every diagnostic below is GNU tar 1.35's own wording, pinned on
// debian:stable-slim; only the hint line is mirage's, for the reason
// usage.oldOptionError gives (mirage's tar serves no --usage).
export const USAGE_HINT = "Try 'tar --help' for more information."
export const EMPTY_ARCHIVE = 'tar: Cowardly refusing to create an empty archive'
// argp's mode refusals: a second main operation where the first one is already
// set, and a line that never names one. The double space is GNU's.
export const MODE_CONFLICT =
  "tar: You may not specify more than one '-Acdtrux', '--delete' or  '--test-label' option"
export const NO_MODE =
  "tar: You must specify one of the '-Acdtrux', '--delete' or '--test-label' options"
export const MULTIPLE_ARCHIVES = "tar: Multiple archive files require '-M' option"
// A --strip-components value that is no count, named first.
export const STRIP_COUNT = 'tar: {}: Invalid number of elements'
// GNU normalizes an empty operand to `.` before it stats it, says so, and
// then still names the operand as typed when the stat fails (tar 1.35).
export const EMPTY_MEMBER = "tar: Substituting `.' for empty member name"
export const FATAL_TRAILER = 'tar: Error is not recoverable: exiting now'
// What GNU adds when the archive opened but its first read failed (a
// directory given to -f).
export const TAPE_START = 'tar: At beginning of tape, quitting now'
// What tar adds when its gzip -d child fails, after gzip's own lines.
export const CHILD_STATUS = 'tar: Child returned status {}'
// With a compressor, the archive is opened by tar's child, which names
// itself so on every line it prints (tar 1.35).
export const CHILD_NAME = 'tar (child)'
// What the compressor the child already spawned says when the child dies
// before feeding it, which happens for every open failure but a missing name
// (gzip 1.13, xz 5.4). bzip2's complaint is a paragraph of recovery advice
// that mirage does not reproduce.
export const EMPTY_PIPE: Readonly<Partial<Record<CompressionKind, readonly string[]>>> =
  Object.freeze({
    gzip: ['', 'gzip: stdin: unexpected end of file'],
    xz: ['xz: (stdin): File format not recognized'],
  })
// The child decompressor's refusal of an input that does not start with its
// magic, by compression: the magic, the line, the child's status, and whether
// an empty input is refused the same way (bzip2 1.0.8 answers an empty or cut
// input with a paragraph of recovery advice mirage does not reproduce; xz
// 5.8.1 refuses an empty one in these words). Mirrors Python's FOREIGN_INPUT.
export const FOREIGN_INPUT: Readonly<
  Partial<
    Record<CompressionKind, { magic: Uint8Array; line: string; status: number; emptyToo: boolean }>
  >
> = Object.freeze({
  bzip2: {
    magic: new Uint8Array([0x42, 0x5a, 0x68]),
    line: 'bzip2: (stdin) is not a bzip2 file.',
    status: 2,
    emptyToo: false,
  },
  xz: {
    magic: new Uint8Array([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]),
    line: 'xz: (stdin): File format not recognized',
    status: 1,
    emptyToo: true,
  },
})
// What GNU says when a member's data runs past the end of the archive.
export const UNEXPECTED_EOF = 'tar: Unexpected EOF in archive'
export const INVALID_ARCHIVE = [
  'tar: This does not look like a tar archive',
  'tar: Skipping to next header',
] as const
export const ERROR_TRAILER = 'tar: Exiting with failure status due to previous errors'
export const SELF_DUMP = 'archive cannot contain itself; not dumped'
// The exit GNU gives an operand it could not read, and a -C it could not
// enter. Both are fatal for the whole run, not per-operand.
export const CREATE_ERROR_EXIT = 2
