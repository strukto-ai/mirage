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
  base64: new CommandSpec({
    options: [
      new Option({ short: '-d', long: '--decode' }),
      new Option({ short: '-D' }),
      new Option({ short: '-w', long: '--wrap', valueKind: OperandKind.TEXT }),
      new Option({ short: '-i', long: '--ignore-garbage' }),
    ],
    positional: [new Operand({ kind: OperandKind.PATH })],
  }),
  cmp: new CommandSpec({
    options: [
      new Option({ short: '-l' }),
      new Option({ short: '-s' }),
      new Option({ short: '-n', valueKind: OperandKind.TEXT }),
      new Option({ short: '-b' }),
      new Option({ short: '-i', valueKind: OperandKind.TEXT }),
    ],
    positional: [new Operand({ kind: OperandKind.PATH }), new Operand({ kind: OperandKind.PATH })],
  }),
  diff: new CommandSpec({
    options: [
      new Option({ short: '-i' }),
      new Option({ short: '-w' }),
      new Option({ short: '-b' }),
      new Option({ short: '-e' }),
      new Option({ short: '-u' }),
      new Option({ short: '-q' }),
      new Option({ short: '-r' }),
    ],
    positional: [new Operand({ kind: OperandKind.PATH }), new Operand({ kind: OperandKind.PATH })],
  }),
  iconv: new CommandSpec({
    options: [
      new Option({ short: '-f', valueKind: OperandKind.TEXT }),
      new Option({ short: '-t', valueKind: OperandKind.TEXT }),
      new Option({ short: '-c' }),
      new Option({ short: '-o', valueKind: OperandKind.PATH }),
    ],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  md5: new CommandSpec({ rest: new Operand({ kind: OperandKind.PATH }) }),
  md5sum: new CommandSpec({
    options: [
      new Option({ short: '-c', long: '--check' }),
      new Option({ short: '-b', long: '--binary' }),
      new Option({ short: '-t', long: '--text' }),
      new Option({ long: '--tag' }),
      new Option({ short: '-w', long: '--warn' }),
      new Option({ short: '-z', long: '--zero' }),
      new Option({ long: '--strict' }),
      new Option({ long: '--ignore-missing' }),
      new Option({ long: '--status' }),
      new Option({ long: '--quiet' }),
    ],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  patch: new CommandSpec({
    options: [
      new Option({ short: '-p', valueKind: OperandKind.TEXT }),
      new Option({ short: '-R' }),
      new Option({ short: '-i', valueKind: OperandKind.PATH }),
      new Option({ short: '-N' }),
    ],
    positional: [new Operand({ kind: OperandKind.PATH }), new Operand({ kind: OperandKind.PATH })],
  }),
  sha1sum: new CommandSpec({
    options: [
      new Option({ short: '-c', long: '--check' }),
      new Option({ short: '-b', long: '--binary' }),
      new Option({ short: '-t', long: '--text' }),
      new Option({ long: '--tag' }),
      new Option({ short: '-w', long: '--warn' }),
      new Option({ short: '-z', long: '--zero' }),
      new Option({ long: '--strict' }),
      new Option({ long: '--ignore-missing' }),
      new Option({ long: '--status' }),
      new Option({ long: '--quiet' }),
    ],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  sha256sum: new CommandSpec({
    options: [
      new Option({ short: '-c', long: '--check' }),
      new Option({ short: '-b', long: '--binary' }),
      new Option({ short: '-t', long: '--text' }),
      new Option({ long: '--tag' }),
      new Option({ short: '-w', long: '--warn' }),
      new Option({ short: '-z', long: '--zero' }),
      new Option({ long: '--strict' }),
      new Option({ long: '--ignore-missing' }),
      new Option({ long: '--status' }),
      new Option({ long: '--quiet' }),
    ],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  sha384sum: new CommandSpec({
    options: [
      new Option({ short: '-c', long: '--check' }),
      new Option({ short: '-b', long: '--binary' }),
      new Option({ short: '-t', long: '--text' }),
      new Option({ long: '--tag' }),
      new Option({ short: '-w', long: '--warn' }),
      new Option({ short: '-z', long: '--zero' }),
      new Option({ long: '--strict' }),
      new Option({ long: '--ignore-missing' }),
      new Option({ long: '--status' }),
      new Option({ long: '--quiet' }),
    ],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  sha512sum: new CommandSpec({
    options: [
      new Option({ short: '-c', long: '--check' }),
      new Option({ short: '-b', long: '--binary' }),
      new Option({ short: '-t', long: '--text' }),
      new Option({ long: '--tag' }),
      new Option({ short: '-w', long: '--warn' }),
      new Option({ short: '-z', long: '--zero' }),
      new Option({ long: '--strict' }),
      new Option({ long: '--ignore-missing' }),
      new Option({ long: '--status' }),
      new Option({ long: '--quiet' }),
    ],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  xxd: new CommandSpec({
    options: [
      new Option({ short: '-r' }),
      new Option({ short: '-p' }),
      new Option({ short: '-l', valueKind: OperandKind.TEXT }),
      new Option({ short: '-c', valueKind: OperandKind.TEXT }),
      new Option({ short: '-s', valueKind: OperandKind.TEXT }),
      new Option({ short: '-g', valueKind: OperandKind.TEXT }),
      new Option({ short: '-u' }),
    ],
    positional: [new Operand({ kind: OperandKind.PATH }), new Operand({ kind: OperandKind.PATH })],
  }),
}
