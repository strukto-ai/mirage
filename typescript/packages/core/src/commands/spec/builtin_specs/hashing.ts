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

import { CommandSpec, Operand, Option } from '../types.ts'

export const SPECS: Record<string, CommandSpec> = {
  base64: new CommandSpec({
    options: [
      new Option({ short: '-d', long: '--decode' }),
      new Option({ short: '-D' }),
      new Option({ short: '-w', long: '--wrap', type: 'str' }),
      new Option({ short: '-i', long: '--ignore-garbage' }),
    ],
    positional: [new Operand({ type: 'path' })],
  }),
  cmp: new CommandSpec({
    options: [
      new Option({ short: '-l', long: '--verbose' }),
      new Option({ short: '-s', long: '--quiet' }),
      new Option({ long: '--silent' }),
      new Option({ short: '-n', long: '--bytes', type: 'str' }),
      new Option({ short: '-b', long: '--print-bytes' }),
      new Option({ short: '-i', long: '--ignore-initial', type: 'str' }),
    ],
    // FILE1 [FILE2 [SKIP1 [SKIP2]]]: the skips are byte counts, read as -i
    // reads its own (diffutils 3.10).
    positional: [
      new Operand({ type: 'path' }),
      new Operand({ type: 'path' }),
      new Operand({ type: 'str' }),
      new Operand({ type: 'str' }),
    ],
  }),
  diff: new CommandSpec({
    options: [
      new Option({ short: '-i' }),
      new Option({ short: '-w' }),
      new Option({ short: '-b' }),
      new Option({ short: '-e' }),
      new Option({ short: '-u' }),
      new Option({ short: '-U', type: 'str' }),
      new Option({ long: '--unified', type: 'str', valueOptional: true }),
      new Option({ short: '-q', long: '--brief' }),
      new Option({ short: '-r', long: '--recursive' }),
      new Option({ short: '-N', long: '--new-file' }),
      new Option({ long: '--unidirectional-new-file' }),
      new Option({ short: '-x', long: '--exclude', type: 'str', multiple: true }),
      new Option({ short: '-X', long: '--exclude-from', type: 'path', multiple: true }),
      new Option({ short: '-s', long: '--report-identical-files' }),
    ],
    positional: [new Operand({ type: 'path' }), new Operand({ type: 'path' })],
  }),
  iconv: new CommandSpec({
    options: [
      new Option({ short: '-f', type: 'str' }),
      new Option({ short: '-t', type: 'str' }),
      new Option({ short: '-c' }),
      new Option({ short: '-o', type: 'path' }),
    ],
    rest: new Operand({ type: 'path' }),
  }),
  md5: new CommandSpec({ rest: new Operand({ type: 'path' }) }),
  md5sum: new CommandSpec({
    options: [
      new Option({ short: '-c', long: '--check' }),
      new Option({ short: '-b', long: '--binary' }),
      new Option({ long: '--tag' }),
      new Option({ short: '-t', long: '--text' }),
      new Option({ short: '-w', long: '--warn' }),
      new Option({ short: '-z', long: '--zero' }),
      new Option({ long: '--status' }),
      new Option({ long: '--ignore-missing' }),
      new Option({ long: '--strict' }),
      new Option({ long: '--quiet' }),
    ],
    rest: new Operand({ type: 'path' }),
  }),
  patch: new CommandSpec({
    options: [
      new Option({ short: '-p', type: 'str' }),
      new Option({ short: '-R' }),
      new Option({ short: '-i', type: 'path' }),
      new Option({ short: '-N' }),
    ],
    positional: [new Operand({ type: 'path' }), new Operand({ type: 'path' })],
  }),
  sha1sum: new CommandSpec({
    options: [
      new Option({ short: '-c', long: '--check' }),
      new Option({ short: '-b', long: '--binary' }),
      new Option({ long: '--tag' }),
      new Option({ short: '-t', long: '--text' }),
      new Option({ short: '-w', long: '--warn' }),
      new Option({ short: '-z', long: '--zero' }),
      new Option({ long: '--status' }),
      new Option({ long: '--ignore-missing' }),
      new Option({ long: '--strict' }),
      new Option({ long: '--quiet' }),
    ],
    rest: new Operand({ type: 'path' }),
  }),
  sha256sum: new CommandSpec({
    options: [
      new Option({ short: '-c', long: '--check' }),
      new Option({ short: '-b', long: '--binary' }),
      new Option({ long: '--tag' }),
      new Option({ short: '-t', long: '--text' }),
      new Option({ short: '-w', long: '--warn' }),
      new Option({ short: '-z', long: '--zero' }),
      new Option({ long: '--status' }),
      new Option({ long: '--ignore-missing' }),
      new Option({ long: '--strict' }),
      new Option({ long: '--quiet' }),
    ],
    rest: new Operand({ type: 'path' }),
  }),
  sha384sum: new CommandSpec({
    options: [
      new Option({ short: '-c', long: '--check' }),
      new Option({ short: '-b', long: '--binary' }),
      new Option({ long: '--tag' }),
      new Option({ short: '-t', long: '--text' }),
      new Option({ short: '-w', long: '--warn' }),
      new Option({ short: '-z', long: '--zero' }),
      new Option({ long: '--status' }),
      new Option({ long: '--ignore-missing' }),
      new Option({ long: '--strict' }),
      new Option({ long: '--quiet' }),
    ],
    rest: new Operand({ type: 'path' }),
  }),
  sha512sum: new CommandSpec({
    options: [
      new Option({ short: '-c', long: '--check' }),
      new Option({ short: '-b', long: '--binary' }),
      new Option({ long: '--tag' }),
      new Option({ short: '-t', long: '--text' }),
      new Option({ short: '-w', long: '--warn' }),
      new Option({ short: '-z', long: '--zero' }),
      new Option({ long: '--status' }),
      new Option({ long: '--ignore-missing' }),
      new Option({ long: '--strict' }),
      new Option({ long: '--quiet' }),
    ],
    rest: new Operand({ type: 'path' }),
  }),
  xxd: new CommandSpec({
    options: [
      new Option({ short: '-r' }),
      new Option({ short: '-p' }),
      new Option({ short: '-l', type: 'str' }),
      new Option({ short: '-c', type: 'str' }),
      new Option({ short: '-s', type: 'str' }),
      new Option({ short: '-g', type: 'str' }),
      new Option({ short: '-u' }),
    ],
    positional: [new Operand({ type: 'path' }), new Operand({ type: 'path' })],
  }),
}
