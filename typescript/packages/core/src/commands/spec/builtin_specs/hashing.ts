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
import { CommandSpec, Argument } from '../types.ts'
import { PATH2_OPERAND, PATHS_OPERAND, PATH_OPERAND } from '../constants.ts'

const CHECKSUM = new CommandSpec({
  arguments: [
    new Argument(['-c', '--check'], { action: 'store_true' }),
    new Argument(['-b', '--binary'], { action: 'store_true' }),
    new Argument('--tag', { action: 'store_true' }),
    new Argument(['-t', '--text'], { action: 'store_true' }),
    new Argument(['-w', '--warn'], { action: 'store_true' }),
    new Argument(['-z', '--zero'], { action: 'store_true' }),
    new Argument('--status', { action: 'store_true' }),
    new Argument('--ignore-missing', { action: 'store_true' }),
    new Argument('--strict', { action: 'store_true' }),
    new Argument('--quiet', { action: 'store_true' }),
    PATHS_OPERAND,
  ],
})

export const SPECS: Record<string, CommandSpec> = {
  base64: new CommandSpec({
    arguments: [
      new Argument(['-d', '--decode'], { action: 'store_true' }),
      new Argument('-D', { action: 'store_true' }),
      new Argument(['-w', '--wrap']),
      new Argument(['-i', '--ignore-garbage'], { action: 'store_true' }),
      PATH_OPERAND,
    ],
  }),
  cmp: new CommandSpec({
    arguments: [
      new Argument(['-l', '--verbose'], { action: 'store_true' }),
      new Argument(['-s', '--quiet'], { action: 'store_true' }),
      new Argument('--silent', { action: 'store_true' }),
      new Argument(['-n', '--bytes']),
      new Argument(['-b', '--print-bytes'], { action: 'store_true' }),
      new Argument(['-i', '--ignore-initial']),
      PATH_OPERAND,
      PATH2_OPERAND,
      new Argument('text3', { metavar: '', nargs: '?' }),
      new Argument('text4', { metavar: '', nargs: '?' }),
    ],
  }),
  diff: new CommandSpec({
    arguments: [
      new Argument('-i', { action: 'store_true' }),
      new Argument('-w', { action: 'store_true' }),
      new Argument('-b', { action: 'store_true' }),
      new Argument('-e', { action: 'store_true' }),
      new Argument('-u', { action: 'store_true' }),
      new Argument('-U'),
      new Argument('--unified', { nargs: '?', attachedOnly: true }),
      new Argument(['-q', '--brief'], { action: 'store_true' }),
      new Argument(['-r', '--recursive'], { action: 'store_true' }),
      new Argument(['-N', '--new-file'], { action: 'store_true' }),
      new Argument('--unidirectional-new-file', { action: 'store_true' }),
      new Argument(['-x', '--exclude'], { action: 'append' }),
      new Argument(['-X', '--exclude-from'], { action: 'append', type: 'path' }),
      new Argument(['-s', '--report-identical-files'], { action: 'store_true' }),
      PATH_OPERAND,
      PATH2_OPERAND,
    ],
  }),
  iconv: new CommandSpec({
    arguments: [
      new Argument('-f'),
      new Argument('-t'),
      new Argument('-c', { action: 'store_true' }),
      new Argument('-o', { type: 'path' }),
      new Argument(['-l', '--list'], { action: 'store_true' }),
      PATHS_OPERAND,
    ],
  }),
  md5: new CommandSpec({
    arguments: [PATHS_OPERAND],
  }),
  md5sum: CHECKSUM,
  patch: new CommandSpec({
    arguments: [
      new Argument('-p'),
      new Argument('-R', { action: 'store_true' }),
      new Argument('-i', { type: 'path' }),
      new Argument('-N', { action: 'store_true' }),
      PATH_OPERAND,
      PATH2_OPERAND,
    ],
  }),
  sha1sum: CHECKSUM,
  sha256sum: CHECKSUM,
  sha384sum: CHECKSUM,
  sha512sum: CHECKSUM,
  xxd: new CommandSpec({
    arguments: [
      new Argument('-r', { action: 'store_true' }),
      new Argument('-p', { action: 'store_true' }),
      new Argument('-l'),
      new Argument('-c'),
      new Argument('-s'),
      new Argument('-g'),
      new Argument('-u', { action: 'store_true' }),
      PATH_OPERAND,
      PATH2_OPERAND,
    ],
  }),
}
