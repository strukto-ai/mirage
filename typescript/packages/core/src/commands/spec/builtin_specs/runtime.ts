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
  bash: new CommandSpec({
    description:
      "Run a command string through Mirage's shell. Only `-c` is meaningful; other flags are accepted and ignored. `bash` and `sh` are aliases.",
    options: [
      new Option({
        short: '-c',
        valueKind: OperandKind.TEXT,
        description: 'Read commands from the next argument and execute them.',
      }),
      new Option({
        short: '-s',
        description: 'Read commands from stdin instead of from an argument.',
      }),
      new Option({
        short: '-l',
        description: '(Ignored) Login shell. Mirage does not source profile files.',
      }),
      new Option({
        short: '-i',
        description: '(Ignored) Interactive flag. Mirage shells are non-interactive.',
      }),
      new Option({ short: '-e', description: '(Ignored) Exit on first error.' }),
      new Option({ short: '-u', description: '(Ignored) Treat unset variables as errors.' }),
      new Option({ short: '-x', description: '(Ignored) Print commands as they execute.' }),
      new Option({ long: '--login', description: '(Ignored) Login shell.' }),
      new Option({ long: '--norc', description: '(Ignored) Skip rc files.' }),
      new Option({ long: '--noprofile', description: '(Ignored) Skip profile files.' }),
      new Option({ long: '--posix', description: '(Ignored) POSIX-conformant mode.' }),
    ],
    rest: new Operand({ kind: OperandKind.TEXT }),
  }),
  bc: new CommandSpec({
    description: 'Arbitrary precision calculator language.',
    options: [
      new Option({ short: '-l', description: 'Load the standard math library.' }),
      new Option({ short: '-q', description: 'Suppress the welcome banner.' }),
    ],
    rest: new Operand({ kind: OperandKind.TEXT }),
  }),
  date: new CommandSpec({
    description: 'Print or set the system date and time.',
    options: [
      new Option({
        short: '-d',
        valueKind: OperandKind.TEXT,
        description: 'Display the time described by the given date string.',
      }),
      new Option({ short: '-u', description: 'Use Coordinated Universal Time (UTC).' }),
      new Option({ short: '-I', description: 'Output date in ISO 8601 format.' }),
      new Option({ short: '-R', description: 'Output date in RFC 5322 email format.' }),
    ],
    positional: [new Operand({ kind: OperandKind.TEXT })],
  }),
  expr: new CommandSpec({
    description: 'Evaluate expressions.',
    rest: new Operand({ kind: OperandKind.TEXT }),
  }),
  history: new CommandSpec({
    description: 'Show command history for the session.',
    options: [
      new Option({ short: '-c', description: 'Clear the command history.' }),
      new Option({
        short: '-d',
        valueKind: OperandKind.TEXT,
        description: 'Delete the entry at the given position; negative counts back from the end.',
      }),
      new Option({
        short: '-s',
        description: 'Append the args to the history as a single entry without executing them.',
      }),
      new Option({ short: '-p', description: 'Print the args without storing them.' }),
      new Option({ short: '-a', description: 'Append: no-op (file and store are the same).' }),
      new Option({ short: '-r', description: 'Read: no-op (file and store are the same).' }),
      new Option({ short: '-w', description: 'Write: no-op (file and store are the same).' }),
      new Option({ short: '-n', description: 'Read-new: no-op (file and store are the same).' }),
    ],
    rest: new Operand({ kind: OperandKind.TEXT }),
  }),
  js: new CommandSpec({
    description: 'Run JavaScript on a sandboxed quickjs engine.',
    options: [
      new Option({
        short: '-e',
        valueKind: OperandKind.TEXT,
        description: 'Evaluate the next argument as a script.',
      }),
      new Option({
        short: '-m',
        long: '--module',
        description:
          'Run as an ES module (top-level import/export/await); .mjs files select this automatically.',
      }),
    ],
    rest: new Operand({ kind: OperandKind.TEXT }),
  }),
  mktemp: new CommandSpec({
    options: [
      new Option({ short: '-d', long: '--directory' }),
      new Option({ short: '-p', valueKind: OperandKind.PATH }),
      new Option({ long: '--tmpdir', valueKind: OperandKind.PATH, valueOptional: true }),
      new Option({ short: '-t' }),
      new Option({ short: '-u', long: '--dry-run' }),
      new Option({ short: '-q', long: '--quiet' }),
      new Option({ long: '--suffix', valueKind: OperandKind.TEXT }),
    ],
    positional: [new Operand({ kind: OperandKind.TEXT })],
  }),
  node: new CommandSpec({
    description: 'Run JavaScript on a sandboxed quickjs engine.',
    options: [
      new Option({
        short: '-e',
        valueKind: OperandKind.TEXT,
        description: 'Evaluate the next argument as a script.',
      }),
      new Option({
        short: '-m',
        long: '--module',
        description:
          'Run as an ES module (top-level import/export/await); .mjs files select this automatically.',
      }),
    ],
    rest: new Operand({ kind: OperandKind.TEXT }),
  }),
  python: new CommandSpec({
    options: [new Option({ short: '-c', valueKind: OperandKind.TEXT })],
    rest: new Operand({ kind: OperandKind.TEXT }),
  }),
  python3: new CommandSpec({
    options: [new Option({ short: '-c', valueKind: OperandKind.TEXT })],
    rest: new Operand({ kind: OperandKind.TEXT }),
  }),
  sleep: new CommandSpec({
    description: 'Delay for a specified amount of time.',
    rest: new Operand({ kind: OperandKind.TEXT }),
  }),
}
