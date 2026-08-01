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

import { CommandSpec, Operand, OperandKind, Option } from '../types.ts'

export const SPECS: Record<string, CommandSpec> = {
  comm: new CommandSpec({
    options: [
      new Option({ short: '-1' }),
      new Option({ short: '-2' }),
      new Option({ short: '-3' }),
      new Option({ long: '--check-order' }),
      new Option({ long: '--nocheck-order' }),
      new Option({ long: '--output-delimiter', valueKind: OperandKind.TEXT }),
      new Option({ long: '--total' }),
      new Option({ short: '-z', long: '--zero-terminated' }),
    ],
    positional: [new Operand({ kind: OperandKind.PATH }), new Operand({ kind: OperandKind.PATH })],
  }),
  csplit: new CommandSpec({
    options: [
      new Option({ short: '-f', long: '--prefix', valueKind: OperandKind.PATH }),
      new Option({ short: '-n', long: '--digits', valueKind: OperandKind.TEXT }),
      new Option({ short: '-b', long: '--suffix-format', valueKind: OperandKind.TEXT }),
      new Option({ short: '-k', long: '--keep-files' }),
      new Option({ short: '-s', long: '--quiet' }),
      new Option({ long: '--silent' }),
      new Option({ long: '--suppress-matched' }),
      new Option({ short: '-z', long: '--elide-empty-files' }),
    ],
    positional: [new Operand({ kind: OperandKind.PATH })],
    rest: new Operand({ kind: OperandKind.TEXT }),
  }),
  cut: new CommandSpec({
    options: [
      new Option({ short: '-f', long: '--fields', valueKind: OperandKind.TEXT }),
      new Option({ short: '-F', valueKind: OperandKind.TEXT }),
      new Option({ short: '-d', long: '--delimiter', valueKind: OperandKind.TEXT }),
      new Option({ short: '-c', long: '--characters', valueKind: OperandKind.TEXT }),
      new Option({ short: '-b', long: '--bytes', valueKind: OperandKind.TEXT }),
      new Option({ short: '-n', long: '--no-partial' }),
      new Option({ long: '--complement' }),
      new Option({ short: '-s', long: '--only-delimited' }),
      new Option({ short: '-O', valueKind: OperandKind.TEXT }),
      new Option({ long: '--output-delimiter', valueKind: OperandKind.TEXT }),
      new Option({ short: '-w' }),
      new Option({
        long: '--whitespace-delimited',
        valueKind: OperandKind.TEXT,
        valueOptional: true,
      }),
      new Option({ short: '-z', long: '--zero-terminated' }),
    ],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  echo: new CommandSpec({
    options: [new Option({ short: '-n' }), new Option({ short: '-e' })],
    rest: new Operand({ kind: OperandKind.TEXT }),
  }),
  join: new CommandSpec({
    options: [
      new Option({ short: '-t', valueKind: OperandKind.TEXT }),
      new Option({ short: '-1', valueKind: OperandKind.TEXT }),
      new Option({ short: '-2', valueKind: OperandKind.TEXT }),
      new Option({ short: '-a', valueKind: OperandKind.TEXT }),
      new Option({ short: '-v', valueKind: OperandKind.TEXT }),
      new Option({ short: '-e', valueKind: OperandKind.TEXT }),
      new Option({ short: '-o', valueKind: OperandKind.TEXT }),
      new Option({ short: '-i', long: '--ignore-case' }),
      new Option({ short: '-j', valueKind: OperandKind.TEXT }),
      new Option({ short: '-z', long: '--zero-terminated' }),
      new Option({ long: '--check-order' }),
      new Option({ long: '--nocheck-order' }),
      new Option({ long: '--header' }),
    ],
    positional: [new Operand({ kind: OperandKind.PATH }), new Operand({ kind: OperandKind.PATH })],
  }),
  numfmt: new CommandSpec({
    options: [
      new Option({ long: '--to', valueKind: OperandKind.TEXT }),
      new Option({ long: '--from', valueKind: OperandKind.TEXT }),
      new Option({ long: '--suffix', valueKind: OperandKind.TEXT }),
      new Option({ long: '--grouping' }),
    ],
    rest: new Operand({ kind: OperandKind.TEXT }),
  }),
  paste: new CommandSpec({
    options: [
      new Option({ short: '-d', long: '--delimiters', valueKind: OperandKind.TEXT }),
      new Option({ short: '-s', long: '--serial' }),
      new Option({ short: '-z', long: '--zero-terminated' }),
    ],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  printf: new CommandSpec({
    positional: [new Operand({ kind: OperandKind.TEXT })],
    rest: new Operand({ kind: OperandKind.TEXT }),
  }),
  seq: new CommandSpec({
    description: 'Print a sequence of numbers.',
    options: [
      new Option({
        short: '-s',
        valueKind: OperandKind.TEXT,
        description: 'Use the given string as separator between numbers.',
      }),
      new Option({
        short: '-w',
        description: 'Pad numbers with zeros to equal width.',
      }),
      new Option({
        short: '-f',
        valueKind: OperandKind.TEXT,
        description: 'Format each number with a printf-style format string.',
      }),
    ],
    positional: [
      new Operand({ kind: OperandKind.TEXT }),
      new Operand({ kind: OperandKind.TEXT }),
      new Operand({ kind: OperandKind.TEXT }),
    ],
  }),
  shuf: new CommandSpec({
    options: [
      new Option({ short: '-n', long: '--head-count', valueKind: OperandKind.TEXT }),
      new Option({ short: '-e', long: '--echo' }),
      new Option({ short: '-z', long: '--zero-terminated' }),
      new Option({ short: '-r', long: '--repeat' }),
      new Option({ short: '-i', long: '--input-range', valueKind: OperandKind.TEXT }),
      new Option({ short: '-o', long: '--output', valueKind: OperandKind.PATH }),
    ],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  sort: new CommandSpec({
    options: [
      new Option({ short: '-r', long: '--reverse' }),
      new Option({ short: '-n', long: '--numeric-sort' }),
      new Option({ short: '-u', long: '--unique' }),
      new Option({ short: '-f', long: '--ignore-case' }),
      new Option({ short: '-k', long: '--key', valueKind: OperandKind.TEXT, repeatable: true }),
      new Option({ short: '-t', long: '--field-separator', valueKind: OperandKind.TEXT }),
      new Option({ short: '-h', long: '--human-numeric-sort' }),
      new Option({ short: '-V', long: '--version-sort' }),
      new Option({ short: '-s', long: '--stable' }),
      new Option({ short: '-M', long: '--month-sort' }),
      new Option({ short: '-b', long: '--ignore-leading-blanks' }),
      new Option({ short: '-c' }),
      new Option({ long: '--check', valueKind: OperandKind.TEXT, valueOptional: true }),
      new Option({ short: '-d', long: '--dictionary-order' }),
      new Option({ short: '-g', long: '--general-numeric-sort' }),
      new Option({ short: '-i', long: '--ignore-nonprinting' }),
      new Option({ short: '-m', long: '--merge' }),
      new Option({ short: '-o', long: '--output', valueKind: OperandKind.PATH }),
      new Option({ short: '-z', long: '--zero-terminated' }),
    ],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  split: new CommandSpec({
    options: [
      new Option({ short: '-l', long: '--lines', valueKind: OperandKind.TEXT }),
      new Option({ short: '-b', long: '--bytes', valueKind: OperandKind.TEXT }),
      new Option({ short: '-n', long: '--number', valueKind: OperandKind.TEXT }),
      new Option({
        short: '-d',
        long: '--numeric-suffixes',
        valueKind: OperandKind.TEXT,
        valueOptional: true,
      }),
      new Option({
        short: '-x',
        long: '--hex-suffixes',
        valueKind: OperandKind.TEXT,
        valueOptional: true,
      }),
      new Option({ short: '-a', long: '--suffix-length', valueKind: OperandKind.TEXT }),
      new Option({ long: '--additional-suffix', valueKind: OperandKind.TEXT }),
      new Option({ short: '-t', long: '--separator', valueKind: OperandKind.TEXT }),
    ],
    positional: [new Operand({ kind: OperandKind.PATH }), new Operand({ kind: OperandKind.PATH })],
  }),
  tee: new CommandSpec({
    options: [
      new Option({ short: '-a', long: '--append' }),
      new Option({ short: '-i', long: '--ignore-interrupts' }),
      new Option({ short: '-p' }),
      new Option({ long: '--output-error', valueKind: OperandKind.TEXT, valueOptional: true }),
    ],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  tr: new CommandSpec({
    options: [
      new Option({ short: '-d', long: '--delete' }),
      new Option({ short: '-s', long: '--squeeze-repeats' }),
      new Option({ short: '-c', long: '--complement' }),
      new Option({ short: '-C' }),
      new Option({ short: '-t', long: '--truncate-set1' }),
    ],
    positional: [new Operand({ kind: OperandKind.TEXT }), new Operand({ kind: OperandKind.TEXT })],
  }),
  tsort: new CommandSpec({ positional: [new Operand({ kind: OperandKind.PATH })] }),
  uniq: new CommandSpec({
    options: [
      new Option({ short: '-c', long: '--count' }),
      new Option({ short: '-d', long: '--repeated' }),
      new Option({ short: '-D' }),
      new Option({ long: '--all-repeated', valueKind: OperandKind.TEXT, valueOptional: true }),
      new Option({ long: '--group', valueKind: OperandKind.TEXT, valueOptional: true }),
      new Option({ short: '-u', long: '--unique' }),
      new Option({ short: '-f', long: '--skip-fields', valueKind: OperandKind.TEXT }),
      new Option({ short: '-s', long: '--skip-chars', valueKind: OperandKind.TEXT }),
      new Option({ short: '-i', long: '--ignore-case' }),
      new Option({ short: '-w', long: '--check-chars', valueKind: OperandKind.TEXT }),
      new Option({ short: '-z', long: '--zero-terminated' }),
    ],
    positional: [new Operand({ kind: OperandKind.PATH }), new Operand({ kind: OperandKind.PATH })],
  }),
  wc: new CommandSpec({
    options: [
      new Option({ short: '-l', long: '--lines' }),
      new Option({ short: '-w', long: '--words' }),
      new Option({ short: '-c', long: '--bytes' }),
      new Option({ short: '-m', long: '--chars' }),
      new Option({ short: '-L', long: '--max-line-length' }),
      new Option({ long: '--total', valueKind: OperandKind.TEXT }),
    ],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
}
