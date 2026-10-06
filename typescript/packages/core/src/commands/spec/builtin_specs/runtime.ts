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

// CPython's own option table, minus four switches that describe a
// process mirage does not have: -i (drop to an interactive prompt), -d
// (parser debug, a debug-build-only switch), -v (trace every import to
// stderr) and the --help-env/--help-xoptions/--help-all dumps, which
// document a CPython build rather than this command. Everything else
// CPython accepts, this accepts.
//
// The four groups differ in who answers them: -c/-m select the source
// and end option parsing (their argument is a program, so trailing
// words are that program's argv); -x also selects source, by dropping
// the script file's first line, and is answered here rather than by a
// runtime because every engine reads the same resolved text; the init
// switches are handed to the runtime through RunArgs.flags and honored
// by whichever engine can; -u is a structural no-op, since mirage
// buffers every stream and returns it whole. Pinned against CPython
// 3.12.11.
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
  new Option({
    short: '-b',
    count: true,
    description: 'Warn on str(bytes) and on comparing bytes with str; -bb raises instead.',
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
    short: '-P',
    description: "Do not prepend the script's directory to sys.path.",
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
    short: '-x',
    description: "Skip the script file's first line, for a non-Unix #! form.",
  }),
  new Option({
    short: '-X',
    type: 'str',
    multiple: true,
    description: 'Set an implementation-specific option.',
  }),
  // CPython parses this one by hand and so rejects the --opt=value
  // spelling it accepts everywhere else; mirage's parser takes both,
  // which is the harmless direction to diverge in.
  new Option({
    long: '--check-hash-based-pycs',
    type: 'str',
    choices: ['always', 'default', 'never'],
    description: 'How to validate hash-based .pyc files.',
  }),
  // -VV shares the concise version line; build details are not exposed.
  new Option({ short: '-h', long: '--help', description: 'Show this help message and exit.' }),
  new Option({
    short: '-V',
    long: '--version',
    description: 'Show version information and exit.',
  }),
]

// CPython's own synopsis, `[-c cmd | -m mod | file | -] [arg] ...`: the
// first operand is a file the interpreter reads, unless a -c or -m
// already named the program, and the words after it are the program's
// argv. The slot has to say so, because a runtime that reads the script
// itself (a sandbox, a host process) is outside every op door, so the
// admission gate is the one place a path rule can see the file.
const PYTHON_SCRIPT = new Operand({ type: 'path', providedBy: ['-c', '-m'] })

// node's `[script.js | -e "script" | -] [arguments]`, the same shape.
const JS_SCRIPT = new Operand({ type: 'path', providedBy: ['-e'] })

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
        long: '--date',
        type: 'str',
        description: 'Display the time described by the given date string.',
      }),
      // GNU -I[FMT]: the precision rides attached (-Is) or after `=`, never
      // as the next word, and matches by prefix in GNU's own table order.
      new Option({
        short: '-I',
        long: '--iso-8601',
        type: 'str',
        valueOptional: true,
        choices: ['hours', 'minutes', 'date', 'seconds', 'ns'],
        description: 'Output date/time in ISO 8601 format, to the given precision (default date).',
      }),
      new Option({
        short: '-R',
        long: '--rfc-email',
        description: 'Output date in RFC 5322 email format.',
      }),
      new Option({
        long: '--rfc-3339',
        type: 'str',
        choices: ['date', 'seconds', 'ns'],
        description: 'Output date/time in RFC 3339 format, to the given precision.',
      }),
      new Option({
        short: '-u',
        long: '--utc',
        description: 'Use Coordinated Universal Time (UTC).',
      }),
      new Option({ long: '--universal', description: 'Use Coordinated Universal Time (UTC).' }),
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
  // js and node take the remainder for the same reason python does: the
  // first operand is a program, so the words after it are that program's
  // argv, not the interpreter's flags. `node - -e x` runs the piped
  // program and hands it `-e x`; `node s.js -m` hands s.js its own -m.
  // Pinned against node 22.8.0.
  js: new CommandSpec({
    description: 'Run JavaScript on a sandboxed quickjs engine.',
    options: [
      new Option({
        short: '-v',
        long: '--version',
        description: 'Show runtime version information and exit.',
      }),
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
    positional: [JS_SCRIPT],
    rest: new Operand({ type: 'str', remainder: true }),
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
  // An alias of js, remainder included; see the note there.
  node: new CommandSpec({
    description: 'Run JavaScript on a sandboxed quickjs engine.',
    options: [
      new Option({
        short: '-v',
        long: '--version',
        description: 'Show runtime version information and exit.',
      }),
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
    positional: [JS_SCRIPT],
    rest: new Operand({ type: 'str', remainder: true }),
  }),
  python: new CommandSpec({
    description: "Run Python on the workspace's bound runtime.",
    options: PYTHON_OPTIONS,
    positional: [PYTHON_SCRIPT],
    rest: new Operand({ type: 'str', remainder: true }),
  }),
  python3: new CommandSpec({
    description: "Run Python on the workspace's bound runtime.",
    options: PYTHON_OPTIONS,
    positional: [PYTHON_SCRIPT],
    rest: new Operand({ type: 'str', remainder: true }),
  }),
  uname: new CommandSpec({
    description: 'Print certain system information.',
    options: [
      new Option({
        short: '-a',
        long: '--all',
        description: 'Print all information, omitting -p and -i if unknown.',
      }),
      new Option({ short: '-s', long: '--kernel-name', description: 'Print the kernel name.' }),
      new Option({
        short: '-n',
        long: '--nodename',
        description: 'Print the network node hostname.',
      }),
      new Option({
        short: '-r',
        long: '--kernel-release',
        description: 'Print the kernel release.',
      }),
      new Option({
        short: '-v',
        long: '--kernel-version',
        description: 'Print the kernel version.',
      }),
      new Option({
        short: '-m',
        long: '--machine',
        description: 'Print the machine hardware name.',
      }),
      new Option({
        short: '-p',
        long: '--processor',
        description: 'Print the processor type.',
      }),
      new Option({
        short: '-i',
        long: '--hardware-platform',
        description: 'Print the hardware platform.',
      }),
      new Option({
        short: '-o',
        long: '--operating-system',
        description: 'Print the operating system.',
      }),
    ],
    rest: new Operand({ type: 'str' }),
  }),
  hostname: new CommandSpec({
    description: "Show or set the system's host name.",
    options: [
      new Option({ short: '-a', long: '--alias', description: 'Alias names.' }),
      new Option({ short: '-A', long: '--all-fqdns', description: 'All long host names (FQDNs).' }),
      new Option({
        short: '-b',
        long: '--boot',
        description: 'Set default hostname if none available.',
      }),
      new Option({ short: '-d', long: '--domain', description: 'DNS domain name.' }),
      new Option({ short: '-f', long: '--fqdn', description: 'Long host name (FQDN).' }),
      new Option({ long: '--long', description: 'Long host name (FQDN).' }),
      new Option({
        short: '-F',
        long: '--file',
        type: 'str',
        description: 'Read host name or NIS domain name from given file.',
      }),
      new Option({
        short: '-i',
        long: '--ip-address',
        description: 'Addresses for the host name.',
      }),
      new Option({
        short: '-I',
        long: '--all-ip-addresses',
        description: 'All addresses for the host.',
      }),
      new Option({ short: '-s', long: '--short', description: 'Short host name.' }),
      new Option({ short: '-y', long: '--yp', description: 'NIS/YP domain name.' }),
      new Option({ long: '--nis', description: 'NIS/YP domain name.' }),
    ],
    rest: new Operand({ type: 'str' }),
  }),
  id: new CommandSpec({
    description:
      'Print user and group information for each specified USER, or (when USER omitted) for the current process.',
    options: [
      new Option({ short: '-a', description: 'Ignore, for compatibility with other versions.' }),
      new Option({
        short: '-Z',
        long: '--context',
        description: 'Print only the security context of the process.',
      }),
      new Option({
        short: '-g',
        long: '--group',
        description: 'Print only the effective group ID.',
      }),
      new Option({ short: '-G', long: '--groups', description: 'Print all group IDs.' }),
      new Option({
        short: '-n',
        long: '--name',
        description: 'Print a name instead of a number, for -u,-g,-G.',
      }),
      new Option({
        short: '-r',
        long: '--real',
        description: 'Print the real ID instead of the effective ID, with -u,-g,-G.',
      }),
      new Option({ short: '-u', long: '--user', description: 'Print only the effective user ID.' }),
      new Option({
        short: '-z',
        long: '--zero',
        description:
          'Delimit entries with NUL characters, not whitespace; not permitted in default format.',
      }),
    ],
    rest: new Operand({ type: 'str' }),
  }),
  getconf: new CommandSpec({
    description:
      'Get the configuration value for variable VAR, or for variable PATH_VAR for path PATH.',
    options: [
      new Option({ short: '-a', description: 'Print every variable and its value.' }),
      new Option({
        short: '-v',
        type: 'str',
        description: 'Give values for compilation environment SPEC.',
      }),
    ],
    rest: new Operand({ type: 'str' }),
  }),
  sleep: new CommandSpec({
    description: 'Delay for a specified amount of time.',
    rest: new Operand({ type: 'str' }),
  }),
}
