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

// CPython's own option table, minus the interactive-only switches. The
// three groups differ in who answers them: -c/-m select the source and
// end option parsing (their argument is a program, so trailing words are
// that program's argv); the init switches are handed to the runtime
// through RunArgs.flags and honored by whichever engine can; -u is a
// structural no-op, since mirage buffers every stream and returns it
// whole. Pinned against CPython 3.12.13.
const PYTHON_OPTIONS: readonly Option[] = [
  new Option({
    short: '-c',
    type: 'str',

    description: 'Run the next argument as a program.',
  }),
  new Option({
    short: '-m',
    type: 'str',

    description: 'Run the named module as __main__.',
  }),
  new Option({
    short: '-u',
    description: '(Ignored) Unbuffered output. Mirage buffers every stream and returns it whole.',
  }),
  new Option({ short: '-B', description: 'Do not write .pyc files on import.' }),
  new Option({ short: '-E', description: 'Ignore PYTHON* environment variables.' }),
  new Option({ short: '-I', description: 'Isolated mode: implies -E and -s.' }),
  new Option({
    short: '-O',
    count: true,
    description: 'Remove assert and __debug__ blocks; -OO also strips docstrings.',
  }),
  new Option({
    short: '-q',
    description: '(Ignored) Suppress the version banner. Mirage prints none.',
  }),
  new Option({ short: '-s', description: 'Do not add the user site directory to sys.path.' }),
  new Option({ short: '-S', description: "Do not run 'import site' on initialization." }),
  new Option({
    short: '-W',
    type: 'str',
    multiple: true,
    description: 'Set a warning control filter.',
  }),
  new Option({
    short: '-X',
    type: 'str',
    multiple: true,
    description: 'Set an implementation-specific option.',
  }),
  // Aliases of the injected help/version options, not new behavior:
  // sharing their long spelling means they share their dest, so the
  // help/version tier short-circuits them on the one path every command
  // uses. CPython's -VV adds build info; mirage has no CPython build to
  // report, so -VV clusters into -V and prints the same line.
  new Option({ short: '-h', long: '--help', description: 'Show this help message and exit.' }),
  new Option({
    short: '-V',
    long: '--version',
    description: 'Show version information and exit.',
  }),
]

export const SPECS: Record<string, CommandSpec> = {
  bash: new CommandSpec({
    description:
      "Run a command string through Mirage's shell. Only `-c` is meaningful; other flags are accepted and ignored. `bash` and `sh` are aliases.",
    options: [
      new Option({
        short: '-c',
        type: 'str',
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
    rest: new Operand({ type: 'str' }),
  }),
  bc: new CommandSpec({
    description: 'Arbitrary precision calculator language.',
    options: [
      new Option({ short: '-l', description: 'Load the standard math library.' }),
      new Option({ short: '-q', description: 'Suppress the welcome banner.' }),
    ],
    rest: new Operand({ type: 'str' }),
  }),
  date: new CommandSpec({
    description: 'Print or set the system date and time.',
    options: [
      new Option({
        short: '-d',
        type: 'str',
        description: 'Display the time described by the given date string.',
      }),
      new Option({ short: '-u', description: 'Use Coordinated Universal Time (UTC).' }),
      new Option({ short: '-I', description: 'Output date in ISO 8601 format.' }),
      new Option({ short: '-R', description: 'Output date in RFC 5322 email format.' }),
    ],
    positional: [new Operand({ type: 'str' })],
  }),
  expr: new CommandSpec({
    description: 'Evaluate expressions.',
    rest: new Operand({ type: 'str' }),
  }),
  history: new CommandSpec({
    description: 'Show command history for the session.',
    options: [
      new Option({ short: '-c', description: 'Clear the command history.' }),
      new Option({
        short: '-d',
        type: 'str',
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
    rest: new Operand({ type: 'str' }),
  }),
  js: new CommandSpec({
    description: 'Run JavaScript on a sandboxed quickjs engine.',
    options: [
      new Option({
        short: '-e',
        type: 'str',
        description: 'Evaluate the next argument as a script.',
      }),
      new Option({
        short: '-m',
        long: '--module',
        description:
          'Run as an ES module (top-level import/export/await); .mjs files select this automatically.',
      }),
    ],
    rest: new Operand({ type: 'str' }),
  }),
  mktemp: new CommandSpec({
    options: [
      new Option({ short: '-d', long: '--directory' }),
      new Option({ short: '-p', type: 'path' }),
      new Option({ long: '--tmpdir', type: 'path', valueOptional: true }),
      new Option({ short: '-t' }),
      new Option({ short: '-u', long: '--dry-run' }),
      new Option({ short: '-q', long: '--quiet' }),
      new Option({ long: '--suffix', type: 'str' }),
    ],
    positional: [new Operand({ type: 'str' })],
  }),
  node: new CommandSpec({
    description: 'Run JavaScript on a sandboxed quickjs engine.',
    options: [
      new Option({
        short: '-e',
        type: 'str',
        description: 'Evaluate the next argument as a script.',
      }),
      new Option({
        short: '-m',
        long: '--module',
        description:
          'Run as an ES module (top-level import/export/await); .mjs files select this automatically.',
      }),
    ],
    rest: new Operand({ type: 'str' }),
  }),
  python: new CommandSpec({
    description: "Run Python on the workspace's bound runtime.",
    options: PYTHON_OPTIONS,
    rest: new Operand({ type: 'str', remainder: true }),
  }),
  python3: new CommandSpec({
    description: "Run Python on the workspace's bound runtime.",
    options: PYTHON_OPTIONS,
    rest: new Operand({ type: 'str', remainder: true }),
  }),
  sleep: new CommandSpec({
    description: 'Delay for a specified amount of time.',
    rest: new Operand({ type: 'str' }),
  }),
}
