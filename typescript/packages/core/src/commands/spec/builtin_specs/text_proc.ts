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
  comm: new CommandSpec({
    options: [
      new Option({ short: '-1' }),
      new Option({ short: '-2' }),
      new Option({ short: '-3' }),
      new Option({ long: '--check-order' }),
      new Option({ long: '--nocheck-order' }),
      new Option({ long: '--output-delimiter', type: 'str' }),
      new Option({ long: '--total' }),
      new Option({ short: '-z', long: '--zero-terminated' }),
    ],
    positional: [new Operand({ type: 'path' }), new Operand({ type: 'path' })],
  }),
  csplit: new CommandSpec({
    options: [
      new Option({ short: '-f', long: '--prefix', type: 'path' }),
      new Option({ short: '-n', long: '--digits', type: 'str' }),
      new Option({ short: '-b', long: '--suffix-format', type: 'str' }),
      new Option({ short: '-k', long: '--keep-files' }),
      new Option({ short: '-s', long: '--quiet' }),
      new Option({ long: '--silent' }),
      new Option({ long: '--suppress-matched' }),
      new Option({ short: '-z', long: '--elide-empty-files' }),
    ],
    positional: [new Operand({ type: 'path' })],
    rest: new Operand({ type: 'str' }),
  }),
  cut: new CommandSpec({
    options: [
      new Option({ short: '-f', long: '--fields', type: 'str' }),
      new Option({ short: '-F', type: 'str' }),
      new Option({ short: '-d', long: '--delimiter', type: 'str' }),
      new Option({ short: '-c', long: '--characters', type: 'str' }),
      new Option({ short: '-b', long: '--bytes', type: 'str' }),
      new Option({ short: '-n', long: '--no-partial' }),
      new Option({ long: '--complement' }),
      new Option({ short: '-s', long: '--only-delimited' }),
      new Option({ short: '-O', type: 'str' }),
      new Option({ long: '--output-delimiter', type: 'str' }),
      new Option({ short: '-w' }),
      new Option({
        long: '--whitespace-delimited',
        type: 'str',
        valueOptional: true,
      }),
      new Option({ short: '-z', long: '--zero-terminated' }),
    ],
    rest: new Operand({ type: 'path' }),
  }),
  echo: new CommandSpec({
    options: [new Option({ short: '-n' }), new Option({ short: '-e' })],
    rest: new Operand({ type: 'str' }),
  }),
  join: new CommandSpec({
    options: [
      new Option({ short: '-t', type: 'str' }),
      new Option({ short: '-1', type: 'str' }),
      new Option({ short: '-2', type: 'str' }),
      new Option({ short: '-a', type: 'str' }),
      new Option({ short: '-v', type: 'str' }),
      new Option({ short: '-e', type: 'str' }),
      new Option({ short: '-o', type: 'str' }),
      new Option({ short: '-i', long: '--ignore-case' }),
      new Option({ short: '-j', type: 'str' }),
      new Option({ short: '-z', long: '--zero-terminated' }),
      new Option({ long: '--check-order' }),
      new Option({ long: '--nocheck-order' }),
      new Option({ long: '--header' }),
    ],
    positional: [new Operand({ type: 'path' }), new Operand({ type: 'path' })],
  }),
  numfmt: new CommandSpec({
    options: [
      new Option({ long: '--to', type: 'str' }),
      new Option({ long: '--from', type: 'str' }),
      new Option({ long: '--suffix', type: 'str' }),
      new Option({ long: '--grouping' }),
    ],
    rest: new Operand({ type: 'str' }),
  }),
  paste: new CommandSpec({
    options: [
      new Option({ short: '-d', long: '--delimiters', type: 'str' }),
      new Option({ short: '-s', long: '--serial' }),
      new Option({ short: '-z', long: '--zero-terminated' }),
    ],
    rest: new Operand({ type: 'path' }),
  }),
  printf: new CommandSpec({
    positional: [new Operand({ type: 'str' })],
    rest: new Operand({ type: 'str' }),
  }),
  seq: new CommandSpec({
    description: 'Print a sequence of numbers.',
    options: [
      new Option({
        short: '-s',
        type: 'str',
        description: 'Use the given string as separator between numbers.',
      }),
      new Option({
        short: '-w',
        description: 'Pad numbers with zeros to equal width.',
      }),
      new Option({
        short: '-f',
        type: 'str',
        description: 'Format each number with a printf-style format string.',
      }),
    ],
    positional: [
      new Operand({ type: 'str' }),
      new Operand({ type: 'str' }),
      new Operand({ type: 'str' }),
    ],
  }),
  shuf: new CommandSpec({
    options: [
      new Option({ short: '-n', long: '--head-count', type: 'str' }),
      new Option({ short: '-e', long: '--echo' }),
      new Option({ short: '-z', long: '--zero-terminated' }),
      new Option({ short: '-r', long: '--repeat' }),
      new Option({ short: '-i', long: '--input-range', type: 'str' }),
      new Option({ short: '-o', long: '--output', type: 'path' }),
    ],
    rest: new Operand({ type: 'path' }),
  }),
  sort: new CommandSpec({
    options: [
      new Option({ short: '-r', long: '--reverse' }),
      new Option({ short: '-n', long: '--numeric-sort' }),
      new Option({ short: '-u', long: '--unique' }),
      new Option({ short: '-f', long: '--ignore-case' }),
      new Option({ short: '-k', long: '--key', type: 'str', multiple: true }),
      new Option({ short: '-t', long: '--field-separator', type: 'str' }),
      new Option({ short: '-h', long: '--human-numeric-sort' }),
      new Option({ short: '-V', long: '--version-sort' }),
      new Option({ short: '-s', long: '--stable' }),
      new Option({ short: '-M', long: '--month-sort' }),
      new Option({ short: '-b', long: '--ignore-leading-blanks' }),
      new Option({ short: '-c' }),
      new Option({ long: '--check', type: 'str', valueOptional: true }),
      new Option({ short: '-d', long: '--dictionary-order' }),
      new Option({ short: '-g', long: '--general-numeric-sort' }),
      new Option({ short: '-i', long: '--ignore-nonprinting' }),
      new Option({ short: '-m', long: '--merge' }),
      new Option({ short: '-o', long: '--output', type: 'path' }),
      new Option({ short: '-z', long: '--zero-terminated' }),
    ],
    rest: new Operand({ type: 'path' }),
  }),
  split: new CommandSpec({
    options: [
      new Option({ short: '-l', long: '--lines', type: 'str' }),
      new Option({ short: '-b', long: '--bytes', type: 'str' }),
      new Option({ short: '-n', long: '--number', type: 'str' }),
      new Option({
        short: '-d',
        long: '--numeric-suffixes',
        type: 'str',
        valueOptional: true,
      }),
      new Option({
        short: '-x',
        long: '--hex-suffixes',
        type: 'str',
        valueOptional: true,
      }),
      new Option({ short: '-a', long: '--suffix-length', type: 'str' }),
      new Option({ long: '--additional-suffix', type: 'str' }),
      new Option({ short: '-t', long: '--separator', type: 'str' }),
    ],
    positional: [new Operand({ type: 'path' }), new Operand({ type: 'path' })],
  }),
  tee: new CommandSpec({
    options: [
      new Option({ short: '-a', long: '--append' }),
      new Option({ short: '-i', long: '--ignore-interrupts' }),
      new Option({ short: '-p' }),
      new Option({
        long: '--output-error',
        type: 'str',
        valueOptional: true,
        choices: ['warn', 'warn-nopipe', 'exit', 'exit-nopipe'],
      }),
    ],
    rest: new Operand({ type: 'path' }),
  }),
  tr: new CommandSpec({
    options: [
      new Option({ short: '-d', long: '--delete' }),
      new Option({ short: '-s', long: '--squeeze-repeats' }),
      new Option({ short: '-c', long: '--complement' }),
      new Option({ short: '-C' }),
      new Option({ short: '-t', long: '--truncate-set1' }),
    ],
    positional: [new Operand({ type: 'str' }), new Operand({ type: 'str' })],
  }),
  tsort: new CommandSpec({ positional: [new Operand({ type: 'path' })] }),
  uniq: new CommandSpec({
    options: [
      new Option({ short: '-c', long: '--count' }),
      new Option({ short: '-d', long: '--repeated' }),
      new Option({ short: '-D' }),
      new Option({ long: '--all-repeated', type: 'str', valueOptional: true }),
      new Option({ long: '--group', type: 'str', valueOptional: true }),
      new Option({ short: '-u', long: '--unique' }),
      new Option({ short: '-f', long: '--skip-fields', type: 'str' }),
      new Option({ short: '-s', long: '--skip-chars', type: 'str' }),
      new Option({ short: '-i', long: '--ignore-case' }),
      new Option({ short: '-w', long: '--check-chars', type: 'str' }),
      new Option({ short: '-z', long: '--zero-terminated' }),
    ],
    positional: [new Operand({ type: 'path' }), new Operand({ type: 'path' })],
  }),
  wc: new CommandSpec({
    options: [
      new Option({ short: '-l', long: '--lines' }),
      new Option({ short: '-w', long: '--words' }),
      new Option({ short: '-c', long: '--bytes' }),
      new Option({ short: '-m', long: '--chars' }),
      new Option({ short: '-L', long: '--max-line-length' }),
      new Option({ long: '--total', type: 'str' }),
    ],
    rest: new Operand({ type: 'path' }),
  }),
}
