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
  basename: new CommandSpec({
    options: [
      new Option({ short: '-a', long: '--multiple' }),
      new Option({ short: '-s', long: '--suffix', valueKind: OperandKind.TEXT }),
      new Option({ short: '-z', long: '--zero' }),
    ],
    rest: new Operand({ kind: OperandKind.TEXT }),
  }),
  chgrp: new CommandSpec({
    options: [
      new Option({ short: '-R' }),
      new Option({ short: '-v' }),
      new Option({ short: '-f' }),
      new Option({ short: '-h' }),
    ],
    positional: [new Operand({ kind: OperandKind.TEXT })],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  chmod: new CommandSpec({
    options: [
      new Option({ short: '-R' }),
      new Option({ short: '-v' }),
      new Option({ short: '-f' }),
    ],
    positional: [new Operand({ kind: OperandKind.TEXT })],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  chown: new CommandSpec({
    options: [
      new Option({ short: '-R' }),
      new Option({ short: '-v' }),
      new Option({ short: '-f' }),
      new Option({ short: '-h' }),
    ],
    positional: [new Operand({ kind: OperandKind.TEXT })],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  cp: new CommandSpec({
    options: [
      new Option({ short: '-r' }),
      new Option({ short: '-R', long: '--recursive' }),
      new Option({ short: '-a', long: '--archive' }),
      // Non-interactive control plane (rm precedent): -f/-i are accepted
      // no-ops — there is no prompt, and an overwrite proceeds unless
      // -n/--update say otherwise.
      new Option({ short: '-f', long: '--force' }),
      new Option({ short: '-i', long: '--interactive' }),
      new Option({ short: '-n', long: '--no-clobber' }),
      new Option({ short: '-v', long: '--verbose' }),
      // GNU: -u/-b never take an argument; only --update=/--backup=
      // carry values, so the shorts stay clusterable (-bv).
      new Option({
        short: '-u',
        long: '--update',
        valueKind: OperandKind.TEXT,
        valueOptional: true,
        shortValue: false,
      }),
      new Option({
        short: '-b',
        long: '--backup',
        valueKind: OperandKind.TEXT,
        valueOptional: true,
        shortValue: false,
      }),
      new Option({ short: '-S', long: '--suffix', valueKind: OperandKind.TEXT }),
      new Option({ short: '-t', long: '--target-directory', valueKind: OperandKind.PATH }),
      new Option({ short: '-T', long: '--no-target-directory' }),
      // PathSpec normalizes trailing slashes everywhere, so the GNU
      // spelling is an accepted no-op.
      new Option({ long: '--strip-trailing-slashes' }),
    ],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  dirname: new CommandSpec({
    options: [new Option({ short: '-z', long: '--zero' })],
    rest: new Operand({ kind: OperandKind.TEXT }),
  }),
  ln: new CommandSpec({
    options: [
      new Option({ short: '-s' }),
      new Option({ short: '-f' }),
      new Option({ short: '-n' }),
      new Option({ short: '-v' }),
    ],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  mkdir: new CommandSpec({
    options: [
      new Option({ short: '-p', long: '--parents' }),
      new Option({ short: '-v', long: '--verbose' }),
      new Option({ short: '-m', long: '--mode', valueKind: OperandKind.TEXT }),
      new Option({
        short: '-Z',
        long: '--context',
        valueKind: OperandKind.TEXT,
        valueOptional: true,
      }),
    ],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  mv: new CommandSpec({
    options: [
      // Non-interactive control plane (rm precedent): -f/-i are accepted
      // no-ops — there is no prompt, and an overwrite proceeds unless
      // -n/--update say otherwise.
      new Option({ short: '-f', long: '--force' }),
      new Option({ short: '-i', long: '--interactive' }),
      new Option({ short: '-n', long: '--no-clobber' }),
      new Option({ short: '-v', long: '--verbose' }),
      // GNU: -u/-b never take an argument; only --update=/--backup=
      // carry values, so the shorts stay clusterable (-bv).
      new Option({
        short: '-u',
        long: '--update',
        valueKind: OperandKind.TEXT,
        valueOptional: true,
        shortValue: false,
      }),
      new Option({
        short: '-b',
        long: '--backup',
        valueKind: OperandKind.TEXT,
        valueOptional: true,
        shortValue: false,
      }),
      new Option({ short: '-S', long: '--suffix', valueKind: OperandKind.TEXT }),
      new Option({ short: '-t', long: '--target-directory', valueKind: OperandKind.PATH }),
      new Option({ short: '-T', long: '--no-target-directory' }),
      new Option({ long: '--exchange' }),
      // Cross-mount moves are copy+remove; --no-copy turns them into
      // GNU's cross-device refusal instead.
      new Option({ long: '--no-copy' }),
      // PathSpec normalizes trailing slashes everywhere, so the GNU
      // spelling is an accepted no-op.
      new Option({ long: '--strip-trailing-slashes' }),
    ],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  readlink: new CommandSpec({
    options: [
      new Option({ short: '-f' }),
      new Option({ short: '-e' }),
      new Option({ short: '-m' }),
      new Option({ short: '-n' }),
    ],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  realpath: new CommandSpec({
    options: [new Option({ short: '-e' }), new Option({ short: '-m' })],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  rm: new CommandSpec({
    options: [
      new Option({ short: '-r' }),
      new Option({ short: '-R' }),
      new Option({ short: '-f' }),
      new Option({ short: '-v' }),
      new Option({ short: '-d' }),
      // Non-interactive control plane: -i/-I are accepted no-ops (there is
      // no prompt; removal always proceeds).
      new Option({ short: '-i' }),
      new Option({ short: '-I' }),
      // Mount roots (and /) are structurally protected and never removable,
      // so the root failsafe is always on and cannot be disabled; both
      // spellings are accepted no-ops. Recursion never crosses a mount
      // boundary either, so --one-file-system already matches the default.
      new Option({ long: '--preserve-root' }),
      new Option({ long: '--no-preserve-root' }),
      new Option({ long: '--one-file-system' }),
    ],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  rmdir: new CommandSpec({
    options: [new Option({ short: '-v' })],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  touch: new CommandSpec({
    options: [
      new Option({ short: '-c' }),
      new Option({ short: '-r', valueKind: OperandKind.PATH }),
      new Option({ short: '-d', valueKind: OperandKind.TEXT }),
    ],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  truncate: new CommandSpec({
    options: [new Option({ short: '-s', long: '--size', valueKind: OperandKind.TEXT })],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  unlink: new CommandSpec({ rest: new Operand({ kind: OperandKind.PATH }) }),
}
