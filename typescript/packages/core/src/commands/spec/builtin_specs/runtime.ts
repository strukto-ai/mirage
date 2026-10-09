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
import { CommandSpec, Argument } from '../types.ts'

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
const PYTHON_OPTIONS: readonly Argument[] = [
  new Argument('-c', { help: 'Run the next argument as a program.' }),
  new Argument('-m', { help: 'Run the named module as __main__.' }),
  new Argument('-u', {
    action: 'store_true',
    help: '(Ignored) Unbuffered output. Mirage buffers every stream and returns it whole.',
  }),
  new Argument('-b', {
    action: 'count',
    help: 'Warn on str(bytes) and on comparing bytes with str; -bb raises instead.',
  }),
  new Argument('-B', { action: 'store_true', help: 'Do not write .pyc files on import.' }),
  new Argument('-E', { action: 'store_true', help: 'Ignore PYTHON* environment variables.' }),
  new Argument('-I', { action: 'store_true', help: 'Isolated mode: implies -E and -s.' }),
  new Argument('-O', {
    action: 'count',
    help: 'Remove assert and __debug__ blocks; -OO also strips docstrings.',
  }),
  new Argument('-P', {
    action: 'store_true',
    help: "Do not prepend the script's directory to sys.path.",
  }),
  new Argument('-q', {
    action: 'store_true',
    help: '(Ignored) Suppress the version banner. Mirage prints none.',
  }),
  new Argument('-s', {
    action: 'store_true',
    help: 'Do not add the user site directory to sys.path.',
  }),
  new Argument('-S', { action: 'store_true', help: "Do not run 'import site' on initialization." }),
  new Argument('-W', { action: 'append', help: 'Set a warning control filter.' }),
  new Argument('-x', {
    action: 'store_true',
    help: "Skip the script file's first line, for a non-Unix #! form.",
  }),
  new Argument('-X', { action: 'append', help: 'Set an implementation-specific option.' }),
  // CPython parses this one by hand and so rejects the --opt=value
  // spelling it accepts everywhere else; mirage's parser takes both,
  // which is the harmless direction to diverge in.
  new Argument('--check-hash-based-pycs', {
    choices: ['always', 'default', 'never'],
    help: 'How to validate hash-based .pyc files.',
  }),
  // -VV shares the concise version line; build details are not exposed.
  new Argument(['-h', '--help'], {
    action: 'store_true',
    help: 'Show this help message and exit.',
  }),
  new Argument(['-V', '--version'], {
    action: 'store_true',
    help: 'Show version information and exit.',
  }),
]

// CPython's own synopsis, `[-c cmd | -m mod | file | -] [arg] ...`: the
// first operand is a file the interpreter reads, unless a -c or -m
// already named the program, and the words after it are the program's
// argv. The slot has to say so, because a runtime that reads the script
// itself (a sandbox, a host process) is outside every dispatcher, so the
// admission gate is the one place a path rule can see the file.
const PYTHON_SCRIPT = new Argument('path', {
  metavar: '',
  type: 'path',
  nargs: '?',
  providedBy: ['-c', '-m'],
})

// node's `[script.js | -e "script" | -] [arguments]`, the same shape.
const JS_SCRIPT = new Argument('path', {
  metavar: '',
  type: 'path',
  nargs: '?',
  providedBy: ['-e'],
})

export const SPECS: Record<string, CommandSpec> = {
  bash: new CommandSpec({
    description:
      'Run a program in a nested Mirage shell: the text after `-c`, a script file, or standard input. `bash` and `sh` are aliases.',
    arguments: [
      new Argument('-c', { help: 'Read commands from the next argument and execute them.' }),
      new Argument('-s', {
        action: 'store_true',
        help: 'Read commands from stdin instead of from an argument.',
      }),
      new Argument('-l', {
        action: 'store_true',
        help: '(Ignored) Login shell. Mirage does not source profile files.',
      }),
      new Argument('-i', {
        action: 'store_true',
        help: '(Ignored) Interactive flag. Mirage shells are non-interactive.',
      }),
      new Argument('-e', { action: 'store_true', help: 'Exit on first error.' }),
      new Argument('-u', { action: 'store_true', help: 'Treat unset variables as errors.' }),
      new Argument('-x', { action: 'store_true', help: 'Print commands as they execute.' }),
      new Argument('--debug', { action: 'store_true', help: '(Ignored) Debugging mode.' }),
      new Argument('--init-file', { help: '(Ignored) Read this file instead of ~/.bashrc.' }),
      new Argument('--login', { action: 'store_true', help: '(Ignored) Login shell.' }),
      new Argument('--noediting', { action: 'store_true', help: '(Ignored) No line editing.' }),
      new Argument('--noprofile', { action: 'store_true', help: '(Ignored) Skip profile files.' }),
      new Argument('--norc', { action: 'store_true', help: '(Ignored) Skip rc files.' }),
      new Argument('--posix', { action: 'store_true', help: '(Ignored) POSIX-conformant mode.' }),
      new Argument('--rcfile', { help: '(Ignored) Read this file instead of ~/.bashrc.' }),
      new Argument('--verbose', {
        action: 'store_true',
        help: 'Print input lines as they are read.',
      }),
      new Argument('texts', { metavar: '', nargs: '*' }),
    ],
  }),
  bc: new CommandSpec({
    description: 'Arbitrary precision calculator language.',
    arguments: [
      new Argument('-l', { action: 'store_true', help: 'Load the standard math library.' }),
      new Argument('-q', { action: 'store_true', help: 'Suppress the welcome banner.' }),
      new Argument('texts', { metavar: '', nargs: '*' }),
    ],
  }),
  date: new CommandSpec({
    description: 'Print or set the system date and time.',
    arguments: [
      new Argument(['-d', '--date'], {
        help: 'Display the time described by the given date string.',
      }),
      new Argument(['-I', '--iso-8601'], {
        nargs: '?',
        attachedOnly: true,
        choices: ['hours', 'minutes', 'date', 'seconds', 'ns'],
        help: 'Output date/time in ISO 8601 format, to the given precision (default date).',
      }),
      new Argument(['-R', '--rfc-email'], {
        action: 'store_true',
        help: 'Output date in RFC 5322 email format.',
      }),
      new Argument('--rfc-3339', {
        choices: ['date', 'seconds', 'ns'],
        help: 'Output date/time in RFC 3339 format, to the given precision.',
      }),
      new Argument(['-u', '--utc'], {
        action: 'store_true',
        help: 'Use Coordinated Universal Time (UTC).',
      }),
      new Argument('--universal', {
        action: 'store_true',
        help: 'Use Coordinated Universal Time (UTC).',
      }),
      new Argument('text', { metavar: '', nargs: '?' }),
    ],
  }),
  expr: new CommandSpec({
    description: 'Evaluate expressions.',
    arguments: [new Argument('texts', { metavar: '', nargs: '*' })],
  }),
  history: new CommandSpec({
    description: 'Show command history for the session.',
    arguments: [
      new Argument('-c', { action: 'store_true', help: 'Clear the command history.' }),
      new Argument('-d', {
        help: 'Delete the entry at the given position; negative counts back from the end.',
      }),
      new Argument('-s', {
        action: 'store_true',
        help: 'Append the args to the history as a single entry without executing them.',
      }),
      new Argument('-p', { action: 'store_true', help: 'Print the args without storing them.' }),
      new Argument('-a', {
        action: 'store_true',
        help: 'Append: no-op (file and store are the same).',
      }),
      new Argument('-r', {
        action: 'store_true',
        help: 'Read: no-op (file and store are the same).',
      }),
      new Argument('-w', {
        action: 'store_true',
        help: 'Write: no-op (file and store are the same).',
      }),
      new Argument('-n', {
        action: 'store_true',
        help: 'Read-new: no-op (file and store are the same).',
      }),
      new Argument('texts', { metavar: '', nargs: '*' }),
    ],
  }),
  // js and node take the remainder for the same reason python does: the
  // first operand is a program, so the words after it are that program's
  // argv, not the interpreter's flags. `node - -e x` runs the piped
  // program and hands it `-e x`; `node s.js -m` hands s.js its own -m.
  // Pinned against node 22.8.0.
  js: new CommandSpec({
    description: 'Run JavaScript on a sandboxed quickjs engine.',
    arguments: [
      new Argument(['-v', '--version'], {
        action: 'store_true',
        help: 'Show runtime version information and exit.',
      }),
      new Argument('-e', { help: 'Evaluate the next argument as a script.' }),
      new Argument(['-m', '--module'], {
        action: 'store_true',
        help: 'Run as an ES module (top-level import/export/await); .mjs files select this automatically.',
      }),
      JS_SCRIPT,
      new Argument('texts', { metavar: '', nargs: 'REMAINDER' }),
    ],
  }),
  mktemp: new CommandSpec({
    arguments: [
      new Argument(['-d', '--directory'], { action: 'store_true' }),
      new Argument('-p', { type: 'path' }),
      new Argument('--tmpdir', { type: 'path', nargs: '?', attachedOnly: true }),
      new Argument('-t', { action: 'store_true' }),
      new Argument(['-u', '--dry-run'], { action: 'store_true' }),
      new Argument(['-q', '--quiet'], { action: 'store_true' }),
      new Argument('--suffix'),
      new Argument('text', { metavar: '', nargs: '?' }),
    ],
  }),
  // An alias of js, remainder included; see the note there.
  node: new CommandSpec({
    description: 'Run JavaScript on a sandboxed quickjs engine.',
    arguments: [
      new Argument(['-v', '--version'], {
        action: 'store_true',
        help: 'Show runtime version information and exit.',
      }),
      new Argument('-e', { help: 'Evaluate the next argument as a script.' }),
      new Argument(['-m', '--module'], {
        action: 'store_true',
        help: 'Run as an ES module (top-level import/export/await); .mjs files select this automatically.',
      }),
      JS_SCRIPT,
      new Argument('texts', { metavar: '', nargs: 'REMAINDER' }),
    ],
  }),
  python: new CommandSpec({
    description: "Run Python on the workspace's bound runtime.",
    arguments: [
      ...PYTHON_OPTIONS,
      PYTHON_SCRIPT,
      new Argument('texts', { metavar: '', nargs: 'REMAINDER' }),
    ],
  }),
  python3: new CommandSpec({
    description: "Run Python on the workspace's bound runtime.",
    arguments: [
      ...PYTHON_OPTIONS,
      PYTHON_SCRIPT,
      new Argument('texts', { metavar: '', nargs: 'REMAINDER' }),
    ],
  }),
  uname: new CommandSpec({
    description: 'Print certain system information.',
    arguments: [
      new Argument(['-a', '--all'], {
        action: 'store_true',
        help: 'Print all information, omitting -p and -i if unknown.',
      }),
      new Argument(['-s', '--kernel-name'], {
        action: 'store_true',
        help: 'Print the kernel name.',
      }),
      new Argument(['-n', '--nodename'], {
        action: 'store_true',
        help: 'Print the network node hostname.',
      }),
      new Argument(['-r', '--kernel-release'], {
        action: 'store_true',
        help: 'Print the kernel release.',
      }),
      new Argument(['-v', '--kernel-version'], {
        action: 'store_true',
        help: 'Print the kernel version.',
      }),
      new Argument(['-m', '--machine'], {
        action: 'store_true',
        help: 'Print the machine hardware name.',
      }),
      new Argument(['-p', '--processor'], {
        action: 'store_true',
        help: 'Print the processor type.',
      }),
      new Argument(['-i', '--hardware-platform'], {
        action: 'store_true',
        help: 'Print the hardware platform.',
      }),
      new Argument(['-o', '--operating-system'], {
        action: 'store_true',
        help: 'Print the operating system.',
      }),
      new Argument('texts', { metavar: '', nargs: '*' }),
    ],
  }),
  hostname: new CommandSpec({
    description: "Show or set the system's host name.",
    arguments: [
      new Argument(['-a', '--alias'], { action: 'store_true', help: 'Alias names.' }),
      new Argument(['-A', '--all-fqdns'], {
        action: 'store_true',
        help: 'All long host names (FQDNs).',
      }),
      new Argument(['-b', '--boot'], {
        action: 'store_true',
        help: 'Set default hostname if none available.',
      }),
      new Argument(['-d', '--domain'], { action: 'store_true', help: 'DNS domain name.' }),
      new Argument(['-f', '--fqdn'], { action: 'store_true', help: 'Long host name (FQDN).' }),
      new Argument('--long', { action: 'store_true', help: 'Long host name (FQDN).' }),
      new Argument(['-F', '--file'], {
        help: 'Read host name or NIS domain name from given file.',
      }),
      new Argument(['-i', '--ip-address'], {
        action: 'store_true',
        help: 'Addresses for the host name.',
      }),
      new Argument(['-I', '--all-ip-addresses'], {
        action: 'store_true',
        help: 'All addresses for the host.',
      }),
      new Argument(['-s', '--short'], { action: 'store_true', help: 'Short host name.' }),
      new Argument(['-y', '--yp'], { action: 'store_true', help: 'NIS/YP domain name.' }),
      new Argument('--nis', { action: 'store_true', help: 'NIS/YP domain name.' }),
      new Argument('texts', { metavar: '', nargs: '*' }),
    ],
  }),
  id: new CommandSpec({
    description:
      'Print user and group information for each specified USER, or (when USER omitted) for the current process.',
    arguments: [
      new Argument('-a', {
        action: 'store_true',
        help: 'Ignore, for compatibility with other versions.',
      }),
      new Argument(['-Z', '--context'], {
        action: 'store_true',
        help: 'Print only the security context of the process.',
      }),
      new Argument(['-g', '--group'], {
        action: 'store_true',
        help: 'Print only the effective group ID.',
      }),
      new Argument(['-G', '--groups'], { action: 'store_true', help: 'Print all group IDs.' }),
      new Argument(['-n', '--name'], {
        action: 'store_true',
        help: 'Print a name instead of a number, for -u,-g,-G.',
      }),
      new Argument(['-r', '--real'], {
        action: 'store_true',
        help: 'Print the real ID instead of the effective ID, with -u,-g,-G.',
      }),
      new Argument(['-u', '--user'], {
        action: 'store_true',
        help: 'Print only the effective user ID.',
      }),
      new Argument(['-z', '--zero'], {
        action: 'store_true',
        help: 'Delimit entries with NUL characters, not whitespace; not permitted in default format.',
      }),
      new Argument('texts', { metavar: '', nargs: '*' }),
    ],
  }),
  getconf: new CommandSpec({
    description:
      'Get the configuration value for variable VAR, or for variable PATH_VAR for path PATH.',
    arguments: [
      new Argument('-a', { action: 'store_true', help: 'Print every variable and its value.' }),
      new Argument('-v', { help: 'Give values for compilation environment SPEC.' }),
      new Argument('texts', { metavar: '', nargs: '*' }),
    ],
  }),
  sleep: new CommandSpec({
    description: 'Delay for a specified amount of time.',
    arguments: [new Argument('texts', { metavar: '', nargs: '*' })],
  }),
}
