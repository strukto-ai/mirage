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
  df: new CommandSpec({
    options: [
      new Option({ short: '-h' }),
      new Option({ short: '-H' }),
      new Option({ short: '-k' }),
      new Option({ short: '-i' }),
      new Option({ short: '-a' }),
      new Option({ short: '-T' }),
      new Option({ short: '-P' }),
      new Option({ short: '-B', valueKind: OperandKind.TEXT }),
    ],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  du: new CommandSpec({
    options: [
      new Option({ short: '-h' }),
      new Option({ short: '-s' }),
      new Option({ short: '-a' }),
      new Option({ short: '-d', long: '--max-depth', valueKind: OperandKind.TEXT }),
      new Option({ short: '-c' }),
    ],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  file: new CommandSpec({
    options: [new Option({ short: '-b' }), new Option({ short: '-i' })],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  find: new CommandSpec({
    options: [
      new Option({ short: '-name', valueKind: OperandKind.TEXT, multiple: true }),
      new Option({ short: '-type', valueKind: OperandKind.TEXT, multiple: true }),
      new Option({ short: '-maxdepth', valueKind: OperandKind.TEXT, multiple: true }),
      new Option({ short: '-size', valueKind: OperandKind.TEXT, multiple: true }),
      new Option({ short: '-mtime', valueKind: OperandKind.TEXT, multiple: true }),
      new Option({ short: '-iname', valueKind: OperandKind.TEXT, multiple: true }),
      new Option({ short: '-path', valueKind: OperandKind.TEXT, multiple: true }),
      new Option({ short: '-mindepth', valueKind: OperandKind.TEXT, multiple: true }),
      new Option({ short: '-print' }),
      new Option({ short: '-print0' }),
      new Option({ short: '-delete' }),
      new Option({ short: '-depth' }),
      new Option({ short: '-prune' }),
      new Option({ short: '-ls' }),
      new Option({ short: '-empty' }),
      new Option({ short: '-o' }),
      new Option({ short: '-or' }),
      new Option({ short: '-a' }),
      new Option({ short: '-and' }),
      new Option({ short: '-not' }),
    ],
    rest: new Operand({ kind: OperandKind.PATH }),
    ignoreTokens: ['(', ')'],
  }),
  ls: new CommandSpec({
    options: [
      new Option({ short: '-l' }),
      new Option({ short: '-a' }),
      new Option({ short: '-A' }),
      new Option({ short: '-h' }),
      new Option({ short: '-t' }),
      new Option({ short: '-S' }),
      new Option({ short: '-r' }),
      new Option({ short: '-1' }),
      new Option({ short: '-R' }),
      new Option({ short: '-d' }),
      new Option({ short: '-F' }),
      // Accepted no-op like grep --color (#471).
      new Option({ long: '--color', valueKind: OperandKind.TEXT, valueOptional: true }),
    ],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  pwd: new CommandSpec({
    options: [new Option({ short: '-P' }), new Option({ short: '-L' })],
    rest: new Operand({ kind: OperandKind.TEXT }),
  }),
  stat: new CommandSpec({
    options: [
      new Option({ short: '-c', valueKind: OperandKind.TEXT }),
      new Option({ short: '-f', valueKind: OperandKind.TEXT }),
    ],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  tree: new CommandSpec({
    options: [
      new Option({ short: '-a' }),
      new Option({ short: '-L', valueKind: OperandKind.TEXT }),
      new Option({ short: '-I', valueKind: OperandKind.TEXT }),
      new Option({ short: '-d' }),
      new Option({ short: '-P', valueKind: OperandKind.TEXT }),
    ],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
}
