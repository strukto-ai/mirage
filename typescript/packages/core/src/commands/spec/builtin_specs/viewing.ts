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
  cat: new CommandSpec({
    options: [
      new Option({ short: '-n', long: '--number' }),
      new Option({ short: '-b', long: '--number-nonblank' }),
      new Option({ short: '-E', long: '--show-ends' }),
      new Option({ short: '-T', long: '--show-tabs' }),
      new Option({ short: '-v', long: '--show-nonprinting' }),
      new Option({ short: '-e' }),
      new Option({ short: '-t' }),
      new Option({ short: '-A', long: '--show-all' }),
      new Option({ short: '-s', long: '--squeeze-blank' }),
      new Option({ short: '-u' }),
    ],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  column: new CommandSpec({
    options: [
      new Option({ short: '-t' }),
      new Option({ short: '-s', valueKind: OperandKind.TEXT }),
      new Option({ short: '-o', valueKind: OperandKind.TEXT }),
    ],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  expand: new CommandSpec({
    options: [
      new Option({ short: '-t', long: '--tabs', valueKind: OperandKind.TEXT }),
      new Option({ short: '-i', long: '--initial' }),
    ],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  fmt: new CommandSpec({
    options: [
      new Option({ short: '-w', long: '--width', valueKind: OperandKind.TEXT }),
      new Option({ short: '-g', long: '--goal', valueKind: OperandKind.TEXT }),
      new Option({ short: '-c', long: '--crown-margin' }),
      new Option({ short: '-p', long: '--prefix', valueKind: OperandKind.TEXT }),
      new Option({ short: '-s', long: '--split-only' }),
      new Option({ short: '-t', long: '--tagged-paragraph' }),
      new Option({ short: '-u', long: '--uniform-spacing' }),
    ],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  fold: new CommandSpec({
    options: [
      new Option({ short: '-w', long: '--width', valueKind: OperandKind.TEXT }),
      new Option({ short: '-s', long: '--spaces' }),
      new Option({ short: '-b', long: '--bytes' }),
      new Option({ short: '-c', long: '--characters' }),
    ],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  head: new CommandSpec({
    options: [
      new Option({
        short: '-n',
        long: '--lines',
        valueKind: OperandKind.TEXT,
        numericShorthand: true,
      }),
      new Option({ short: '-c', long: '--bytes', valueKind: OperandKind.TEXT }),
      new Option({ short: '-q', long: '--quiet' }),
      new Option({ long: '--silent' }),
      new Option({ short: '-v', long: '--verbose' }),
      new Option({ short: '-z', long: '--zero-terminated' }),
    ],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  look: new CommandSpec({
    options: [new Option({ short: '-f' })],
    positional: [new Operand({ kind: OperandKind.TEXT }), new Operand({ kind: OperandKind.PATH })],
  }),
  nl: new CommandSpec({
    options: [
      new Option({ short: '-b', long: '--body-numbering', valueKind: OperandKind.TEXT }),
      new Option({ short: '-d', long: '--section-delimiter', valueKind: OperandKind.TEXT }),
      new Option({ short: '-f', long: '--footer-numbering', valueKind: OperandKind.TEXT }),
      new Option({ short: '-h', long: '--header-numbering', valueKind: OperandKind.TEXT }),
      new Option({ short: '-l', long: '--join-blank-lines', valueKind: OperandKind.TEXT }),
      new Option({ short: '-n', long: '--number-format', valueKind: OperandKind.TEXT }),
      new Option({ short: '-p', long: '--no-renumber' }),
      new Option({ short: '-v', long: '--starting-line-number', valueKind: OperandKind.TEXT }),
      new Option({ short: '-i', long: '--line-increment', valueKind: OperandKind.TEXT }),
      new Option({ short: '-w', long: '--number-width', valueKind: OperandKind.TEXT }),
      new Option({ short: '-s', long: '--number-separator', valueKind: OperandKind.TEXT }),
    ],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  od: new CommandSpec({
    options: [
      new Option({ short: '-A', long: '--address-radix', valueKind: OperandKind.TEXT }),
      new Option({ short: '-j', long: '--skip-bytes', valueKind: OperandKind.TEXT }),
      new Option({ short: '-N', long: '--read-bytes', valueKind: OperandKind.TEXT }),
      new Option({ short: '-t', long: '--format', valueKind: OperandKind.TEXT, multiple: true }),
    ],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  rev: new CommandSpec({ rest: new Operand({ kind: OperandKind.PATH }) }),
  tac: new CommandSpec({
    options: [
      new Option({ short: '-b', long: '--before' }),
      new Option({ short: '-r', long: '--regex' }),
      new Option({ short: '-s', long: '--separator', valueKind: OperandKind.TEXT }),
    ],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  tail: new CommandSpec({
    options: [
      new Option({ short: '-n', valueKind: OperandKind.TEXT, numericShorthand: true }),
      new Option({ short: '-c', valueKind: OperandKind.TEXT }),
      new Option({ short: '-q' }),
      new Option({ short: '-v' }),
      new Option({ short: '-f', long: '--follow' }),
    ],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  unexpand: new CommandSpec({
    options: [
      new Option({ short: '-t', long: '--tabs', valueKind: OperandKind.TEXT }),
      new Option({ short: '-a', long: '--all' }),
      new Option({ long: '--first-only' }),
    ],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
}
