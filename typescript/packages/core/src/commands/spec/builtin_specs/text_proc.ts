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

export const SPECS: Record<string, CommandSpec> = {
  comm: new CommandSpec({
    arguments: [
      new Argument('-1', { action: 'store_true' }),
      new Argument('-2', { action: 'store_true' }),
      new Argument('-3', { action: 'store_true' }),
      new Argument('--check-order', { action: 'store_true' }),
      new Argument('--nocheck-order', { action: 'store_true' }),
      new Argument('--output-delimiter'),
      new Argument('--total', { action: 'store_true' }),
      new Argument(['-z', '--zero-terminated'], { action: 'store_true' }),
      new Argument('path', { metavar: '', type: 'path', nargs: '?' }),
      new Argument('path2', { metavar: '', type: 'path', nargs: '?' }),
    ],
  }),
  csplit: new CommandSpec({
    arguments: [
      new Argument(['-f', '--prefix'], { type: 'path' }),
      new Argument(['-n', '--digits']),
      new Argument('--silent', { action: 'store_true' }),
      new Argument(['-k', '--keep-files'], { action: 'store_true' }),
      new Argument(['-s', '--quiet'], { action: 'store_true' }),
      new Argument(['-b', '--suffix-format']),
      new Argument('--suppress-matched', { action: 'store_true' }),
      new Argument(['-z', '--elide-empty-files'], { action: 'store_true' }),
      new Argument('path', { metavar: '', type: 'path', nargs: '?' }),
      new Argument('texts', { metavar: '', nargs: '*' }),
    ],
  }),
  cut: new CommandSpec({
    arguments: [
      new Argument(['-f', '--fields']),
      new Argument('-F'),
      new Argument(['-d', '--delimiter']),
      new Argument(['-c', '--characters']),
      new Argument(['-b', '--bytes']),
      new Argument(['-n', '--no-partial'], { action: 'store_true' }),
      new Argument('--complement', { action: 'store_true' }),
      new Argument(['-s', '--only-delimited'], { action: 'store_true' }),
      new Argument('-O'),
      new Argument('--output-delimiter'),
      new Argument('-w', { action: 'store_true' }),
      new Argument('--whitespace-delimited', { nargs: '?', attachedOnly: true }),
      new Argument(['-z', '--zero-terminated'], { action: 'store_true' }),
      new Argument('paths', { metavar: '', type: 'path', nargs: '*' }),
    ],
  }),
  echo: new CommandSpec({
    arguments: [
      new Argument('-n', { action: 'store_true' }),
      new Argument('-e', { action: 'store_true' }),
      new Argument('texts', { metavar: '', nargs: '*' }),
    ],
  }),
  join: new CommandSpec({
    arguments: [
      new Argument('-t'),
      new Argument('-1'),
      new Argument('-2'),
      new Argument('-a'),
      new Argument('-v'),
      new Argument('-e'),
      new Argument('-o'),
      new Argument(['-i', '--ignore-case'], { action: 'store_true' }),
      new Argument('-j'),
      new Argument(['-z', '--zero-terminated'], { action: 'store_true' }),
      new Argument('--check-order', { action: 'store_true' }),
      new Argument('--nocheck-order', { action: 'store_true' }),
      new Argument('--header', { action: 'store_true' }),
      new Argument('path', { metavar: '', type: 'path', nargs: '?' }),
      new Argument('path2', { metavar: '', type: 'path', nargs: '?' }),
    ],
  }),
  numfmt: new CommandSpec({
    arguments: [
      new Argument('--to', { choices: ['none', 'si', 'iec', 'iec-i'] }),
      new Argument('--from', { choices: ['none', 'auto', 'si', 'iec', 'iec-i'] }),
      new Argument('--suffix'),
      new Argument('--grouping', { action: 'store_true' }),
      new Argument('texts', { metavar: '', nargs: '*' }),
    ],
  }),
  paste: new CommandSpec({
    arguments: [
      new Argument(['-d', '--delimiters']),
      new Argument(['-s', '--serial'], { action: 'store_true' }),
      new Argument(['-z', '--zero-terminated'], { action: 'store_true' }),
      new Argument('paths', { metavar: '', type: 'path', nargs: '*' }),
    ],
  }),
  printf: new CommandSpec({
    arguments: [
      new Argument('text', { metavar: '', nargs: '?' }),
      new Argument('texts', { metavar: '', nargs: '*' }),
    ],
  }),
  seq: new CommandSpec({
    description: 'Print a sequence of numbers.',
    arguments: [
      new Argument(['-s', '--separator'], {
        help: 'Use the given string as separator between numbers.',
      }),
      new Argument(['-w', '--equal-width'], {
        action: 'store_true',
        help: 'Pad numbers with zeros to equal width.',
      }),
      new Argument(['-f', '--format'], {
        help: 'Format each number with a printf-style format string.',
      }),
      new Argument('text', { metavar: '', nargs: '?' }),
      new Argument('text2', { metavar: '', nargs: '?' }),
      new Argument('text3', { metavar: '', nargs: '?' }),
      new Argument('texts', { metavar: '', nargs: 'REMAINDER' }),
    ],
  }),
  shuf: new CommandSpec({
    arguments: [
      new Argument(['-n', '--head-count'], { action: 'append' }),
      new Argument(['-e', '--echo'], { action: 'store_true' }),
      new Argument(['-z', '--zero-terminated'], { action: 'store_true' }),
      new Argument(['-r', '--repeat'], { action: 'store_true' }),
      new Argument(['-i', '--input-range'], { action: 'append' }),
      new Argument(['-o', '--output'], { action: 'append', type: 'path' }),
      new Argument('paths', { metavar: '', type: 'path', nargs: '*' }),
    ],
  }),
  sort: new CommandSpec({
    arguments: [
      new Argument(['-r', '--reverse'], { action: 'store_true' }),
      new Argument(['-n', '--numeric-sort'], { action: 'store_true' }),
      new Argument(['-u', '--unique'], { action: 'store_true' }),
      new Argument(['-b', '--ignore-leading-blanks'], { action: 'store_true' }),
      new Argument(['-k', '--key'], { action: 'append' }),
      new Argument(['-t', '--field-separator']),
      new Argument(['-h', '--human-numeric-sort'], { action: 'store_true' }),
      new Argument(['-V', '--version-sort'], { action: 'store_true' }),
      new Argument(['-s', '--stable'], { action: 'store_true' }),
      new Argument(['-m', '--merge'], { action: 'store_true' }),
      new Argument(['-f', '--ignore-case'], { action: 'store_true' }),
      new Argument('-c', { action: 'store_true' }),
      new Argument('-C', { action: 'store_true' }),
      new Argument('--check', { nargs: '?', attachedOnly: true }),
      new Argument(['-d', '--dictionary-order'], { action: 'store_true' }),
      new Argument(['-g', '--general-numeric-sort'], { action: 'store_true' }),
      new Argument(['-i', '--ignore-nonprinting'], { action: 'store_true' }),
      new Argument(['-M', '--month-sort'], { action: 'store_true' }),
      new Argument(['-o', '--output'], { action: 'append', type: 'path' }),
      new Argument(['-z', '--zero-terminated'], { action: 'store_true' }),
      new Argument('paths', { metavar: '', type: 'path', nargs: '*' }),
    ],
  }),
  split: new CommandSpec({
    arguments: [
      new Argument(['-l', '--lines'], { numericShorthand: true }),
      new Argument(['-b', '--bytes']),
      new Argument(['-n', '--number']),
      new Argument(['-d', '--numeric-suffixes'], {
        nargs: '?',
        attachedOnly: true,
        shortValue: false,
      }),
      new Argument(['-x', '--hex-suffixes'], { nargs: '?', attachedOnly: true, shortValue: false }),
      new Argument(['-a', '--suffix-length']),
      new Argument('--additional-suffix'),
      new Argument(['-t', '--separator']),
      new Argument('path', { metavar: '', type: 'path', nargs: '?' }),
      new Argument('path2', { metavar: '', type: 'path', nargs: '?' }),
    ],
  }),
  tee: new CommandSpec({
    arguments: [
      new Argument(['-a', '--append'], { action: 'store_true' }),
      new Argument(['-i', '--ignore-interrupts'], { action: 'store_true' }),
      new Argument('-p', { action: 'store_true' }),
      new Argument('--output-error', {
        nargs: '?',
        attachedOnly: true,
        choices: ['warn', 'warn-nopipe', 'exit', 'exit-nopipe'],
      }),
      new Argument('paths', { metavar: '', type: 'path', nargs: '*' }),
    ],
  }),
  tr: new CommandSpec({
    arguments: [
      new Argument(['-d', '--delete'], { action: 'store_true' }),
      new Argument(['-s', '--squeeze-repeats'], { action: 'store_true' }),
      new Argument(['-c', '--complement'], { action: 'store_true' }),
      new Argument('-C', { action: 'store_true' }),
      new Argument(['-t', '--truncate-set1'], { action: 'store_true' }),
      new Argument('text', { metavar: '', nargs: '?' }),
      new Argument('text2', { metavar: '', nargs: '?' }),
    ],
  }),
  tsort: new CommandSpec({
    arguments: [new Argument('path', { metavar: '', type: 'path', nargs: '?' })],
  }),
  uniq: new CommandSpec({
    arguments: [
      new Argument(['-c', '--count'], { action: 'store_true' }),
      new Argument(['-d', '--repeated'], { action: 'store_true' }),
      new Argument('-D', { action: 'store_true' }),
      new Argument('--all-repeated', { nargs: '?', attachedOnly: true }),
      new Argument('--group', { nargs: '?', attachedOnly: true }),
      new Argument(['-u', '--unique'], { action: 'store_true' }),
      new Argument(['-f', '--skip-fields']),
      new Argument(['-s', '--skip-chars']),
      new Argument(['-i', '--ignore-case'], { action: 'store_true' }),
      new Argument(['-w', '--check-chars']),
      new Argument(['-z', '--zero-terminated'], { action: 'store_true' }),
      new Argument('path', { metavar: '', type: 'path', nargs: '?' }),
      new Argument('path2', { metavar: '', type: 'path', nargs: '?' }),
    ],
  }),
  wc: new CommandSpec({
    arguments: [
      new Argument(['-l', '--lines'], { action: 'store_true' }),
      new Argument(['-w', '--words'], { action: 'store_true' }),
      new Argument(['-c', '--bytes'], { action: 'store_true' }),
      new Argument(['-m', '--chars'], { action: 'store_true' }),
      new Argument(['-L', '--max-line-length'], { action: 'store_true' }),
      new Argument('--total'),
      new Argument('paths', { metavar: '', type: 'path', nargs: '*' }),
    ],
  }),
}
