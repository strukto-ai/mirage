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

const B2SUM = new CommandSpec({
  arguments: [new Argument(['-l', '--length']), ...CHECKSUM.arguments],
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
      new Argument(['-i', '--ignore-case'], { action: 'store_true' }),
      new Argument(['-w', '--ignore-all-space'], { action: 'store_true' }),
      new Argument(['-b', '--ignore-space-change'], { action: 'store_true' }),
      new Argument(['-E', '--ignore-tab-expansion'], { action: 'store_true' }),
      new Argument(['-Z', '--ignore-trailing-space'], { action: 'store_true' }),
      new Argument(['-B', '--ignore-blank-lines'], { action: 'store_true' }),
      new Argument(['-I', '--ignore-matching-lines'], { action: 'append' }),
      new Argument('--strip-trailing-cr', { action: 'store_true' }),
      new Argument('--speed-large-files', { action: 'store_true' }),
      new Argument('--horizon-lines', { action: 'append' }),
      new Argument(['-a', '--text'], { action: 'store_true' }),
      // The output styles; two different ones are refused.
      new Argument('--normal', { action: 'store_true' }),
      new Argument(['-e', '--ed'], { action: 'store_true' }),
      new Argument(['-n', '--rcs'], { action: 'store_true' }),
      new Argument('-c', { action: 'store_true' }),
      new Argument('-C'),
      new Argument('--context', { nargs: '?', attachedOnly: true }),
      new Argument('-u', { action: 'store_true' }),
      new Argument('-U'),
      new Argument('--unified', { nargs: '?', attachedOnly: true }),
      new Argument(['-y', '--side-by-side'], { action: 'store_true' }),
      new Argument(['-W', '--width']),
      new Argument('--left-column', { action: 'store_true' }),
      new Argument('--suppress-common-lines', { action: 'store_true' }),
      new Argument(['-p', '--show-c-function'], { action: 'store_true' }),
      new Argument(['-F', '--show-function-line'], { action: 'append' }),
      new Argument(['-t', '--expand-tabs'], { action: 'store_true' }),
      new Argument(['-T', '--initial-tab'], { action: 'store_true' }),
      new Argument(['-L', '--label'], { action: 'append' }),
      new Argument('--color', { nargs: '?', attachedOnly: true }),
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
      new Argument(['-f', '--from-code']),
      new Argument(['-t', '--to-code']),
      new Argument('-c', { action: 'store_true' }),
      new Argument(['-o', '--output'], { type: 'path' }),
      new Argument(['-l', '--list'], { action: 'store_true' }),
      new Argument(['-s', '--silent'], { action: 'store_true' }),
      PATHS_OPERAND,
    ],
  }),
  md5: new CommandSpec({
    arguments: [PATHS_OPERAND],
  }),
  md5sum: CHECKSUM,
  b2sum: B2SUM,
  patch: new CommandSpec({
    arguments: [
      new Argument('-p'),
      new Argument('-R', { action: 'store_true' }),
      new Argument('-i', { type: 'path' }),
      new Argument('-N', { action: 'store_true' }),
      // Each -d changes directory from where the one before left it, before
      // anything is read, the operands and -i included.
      new Argument(['-d', '--directory'], { action: 'append' }),
      new Argument('--dry-run', { action: 'store_true' }),
      new Argument(['-b', '--backup'], { action: 'store_true' }),
      new Argument(['-z', '--suffix']),
      new Argument(['-B', '--prefix']),
      new Argument(['-V', '--version-control']),
      new Argument(['-o', '--output']),
      new Argument(['-r', '--reject-file']),
      new Argument(['-s', '--silent', '--quiet'], { action: 'store_true' }),
      new Argument(['-f', '--force'], { action: 'store_true' }),
      new Argument(['-t', '--batch'], { action: 'store_true' }),
      new Argument(['-l', '--ignore-whitespace'], { action: 'store_true' }),
      new Argument(['-F', '--fuzz']),
      new Argument(['-E', '--remove-empty-files'], { action: 'store_true' }),
      new Argument(['-u', '--unified'], { action: 'store_true' }),
      new Argument('--verbose', { action: 'store_true' }),
      PATH_OPERAND,
      PATH2_OPERAND,
    ],
  }),
  sha1sum: CHECKSUM,
  sha224sum: CHECKSUM,
  sha256sum: CHECKSUM,
  sha384sum: CHECKSUM,
  sha512sum: CHECKSUM,
  // xxd spells its long names with one dash, each beside its letter.
  xxd: new CommandSpec({
    arguments: [
      new Argument(['-r', '-revert'], { action: 'store_true' }),
      new Argument(['-p', '-ps', '-postscript', '-plain'], { action: 'store_true' }),
      new Argument(['-l', '-len']),
      new Argument(['-c', '-cols']),
      new Argument(['-s', '-seek']),
      new Argument(['-g', '-groupsize']),
      new Argument(['-u', '-uppercase'], { action: 'store_true' }),
      new Argument(['-a', '-autoskip'], { action: 'store_true' }),
      new Argument(['-b', '-bits'], { action: 'store_true' }),
      new Argument('-C', { action: 'store_true' }),
      new Argument(['-d', '-decimal'], { action: 'store_true' }),
      new Argument(['-E', '-EBCDIC'], { action: 'store_true' }),
      new Argument('-e', { action: 'store_true' }),
      new Argument(['-i', '-include'], { action: 'store_true' }),
      new Argument(['-n', '-name']),
      new Argument(['-o', '-offset']),
      PATH_OPERAND,
      PATH2_OPERAND,
    ],
  }),
}

const CMP = SPECS.cmp
const DIFF = SPECS.diff
if (CMP !== undefined) SPECS.zcmp = CMP
if (DIFF !== undefined) SPECS.zdiff = DIFF
