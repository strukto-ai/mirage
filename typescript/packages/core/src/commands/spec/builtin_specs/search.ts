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
  awk: new CommandSpec({
    options: [
      new Option({ short: '-F', valueKind: OperandKind.TEXT }),
      new Option({ short: '-v', valueKind: OperandKind.TEXT, repeatable: true }),
      new Option({ short: '-f', valueKind: OperandKind.PATH, repeatable: true }),
    ],
    positional: [new Operand({ kind: OperandKind.TEXT, providedBy: ['-f'] })],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  grep: new CommandSpec({
    options: [
      new Option({ short: '-r' }),
      new Option({ short: '-R' }),
      new Option({ short: '-i' }),
      new Option({ short: '-I' }),
      new Option({ short: '-v' }),
      new Option({ short: '-n' }),
      new Option({ short: '-c' }),
      new Option({ short: '-l' }),
      new Option({ short: '-w' }),
      new Option({ short: '-F' }),
      new Option({ short: '-E' }),
      new Option({ short: '-o' }),
      new Option({ short: '-q' }),
      new Option({ short: '-H' }),
      new Option({ short: '-h' }),
      new Option({ short: '-m', valueKind: OperandKind.TEXT }),
      new Option({ short: '-A', valueKind: OperandKind.TEXT }),
      new Option({ short: '-B', valueKind: OperandKind.TEXT }),
      new Option({ short: '-C', valueKind: OperandKind.TEXT }),
      new Option({ short: '-e', valueKind: OperandKind.TEXT, repeatable: true }),
      new Option({ short: '-f', valueKind: OperandKind.PATH, repeatable: true }),
      // Accepted no-ops: output is never a tty, so plain output is
      // exactly what GNU produces with --color=auto (#471).
      new Option({ long: '--color', valueKind: OperandKind.TEXT, valueOptional: true }),
      new Option({ long: '--colour', valueKind: OperandKind.TEXT, valueOptional: true }),
      new Option({ long: '--line-buffered' }),
    ],
    positional: [new Operand({ kind: OperandKind.TEXT, providedBy: ['-e', '-f'] })],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  jq: new CommandSpec({
    options: [
      new Option({ short: '-r' }),
      new Option({ short: '-c' }),
      new Option({ short: '-s' }),
    ],
    positional: [new Operand({ kind: OperandKind.TEXT })],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  rg: new CommandSpec({
    options: [
      new Option({ short: '-i' }),
      new Option({ short: '-v' }),
      new Option({ short: '-n' }),
      new Option({ short: '-c' }),
      new Option({ short: '-l' }),
      new Option({ short: '-w' }),
      new Option({ short: '-F' }),
      new Option({ short: '-o' }),
      new Option({ short: '-H' }),
      new Option({ short: '-I' }),
      new Option({ short: '-e', valueKind: OperandKind.TEXT, repeatable: true }),
      new Option({ short: '-f', valueKind: OperandKind.PATH, repeatable: true }),
      new Option({ short: '-m', valueKind: OperandKind.TEXT }),
      new Option({ short: '-A', valueKind: OperandKind.TEXT }),
      new Option({ short: '-B', valueKind: OperandKind.TEXT }),
      new Option({ short: '-C', valueKind: OperandKind.TEXT }),
      new Option({ long: '--hidden' }),
      new Option({ long: '--type', valueKind: OperandKind.TEXT }),
      new Option({ long: '--glob', valueKind: OperandKind.TEXT }),
      // Accepted no-op like grep --color (#471).
      new Option({ long: '--color', valueKind: OperandKind.TEXT, valueOptional: true }),
    ],
    positional: [new Operand({ kind: OperandKind.TEXT, providedBy: ['-e', '-f'] })],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  search: new CommandSpec({
    options: [
      new Option({ long: '--method', valueKind: OperandKind.TEXT }),
      new Option({ long: '--top-k', valueKind: OperandKind.TEXT }),
      new Option({ long: '--threshold', valueKind: OperandKind.TEXT }),
    ],
    positional: [new Operand({ kind: OperandKind.TEXT })],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  sed: new CommandSpec({
    options: [
      new Option({ short: '-i' }),
      // -e takes a script and may repeat; multiple -e are joined with newlines.
      new Option({ short: '-e', valueKind: OperandKind.TEXT, repeatable: true }),
      // -f reads the script from a file and may repeat (like grep -f); its value
      // is a PATH so it routes and is read from the mount.
      new Option({ short: '-f', valueKind: OperandKind.PATH, repeatable: true }),
      new Option({ short: '-n' }),
      new Option({ short: '-E' }),
      new Option({ short: '-r' }),
    ],
    // providedBy lists the flags that can supply this positional slot's value;
    // when any is present the parser skips the slot so the next word is not
    // mis-grabbed. For sed the first operand is the script (TEXT) only when
    // neither -e nor -f gave one (GNU). With -e/-f the slot is skipped and the
    // first operand reflows to a file path in rest.
    positional: [new Operand({ kind: OperandKind.TEXT, providedBy: ['-e', '-f'] })],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  strings: new CommandSpec({
    options: [new Option({ short: '-n', valueKind: OperandKind.TEXT })],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  zgrep: new CommandSpec({
    options: [
      new Option({ short: '-i' }),
      new Option({ short: '-c' }),
      new Option({ short: '-l' }),
      new Option({ short: '-n' }),
      new Option({ short: '-v' }),
      new Option({ short: '-e', valueKind: OperandKind.TEXT, repeatable: true }),
      new Option({ short: '-f', valueKind: OperandKind.PATH, repeatable: true }),
      new Option({ short: '-E' }),
      new Option({ short: '-F' }),
      new Option({ short: '-H' }),
      new Option({ short: '-h' }),
      new Option({ short: '-m', valueKind: OperandKind.TEXT }),
      new Option({ short: '-o' }),
      new Option({ short: '-q' }),
      new Option({ short: '-w' }),
    ],
    positional: [new Operand({ kind: OperandKind.TEXT, providedBy: ['-e', '-f'] })],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
}
