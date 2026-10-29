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
import { specOf } from './builtins.ts'
import { compileSpec, expandLong, optionSpellings } from './compile.ts'
import { HELP_OPTION, VERSION_OPTION } from './constants.ts'
import { CommandSpec, Argument } from './types.ts'

const DECLARE_OPTIONS = [
  new Argument('-a', { action: 'store_true', help: 'make each NAME an indexed array' }),
  new Argument('-A', { action: 'store_true', help: 'make each NAME an associative array' }),
  new Argument('-f', {
    action: 'store_true',
    help: 'act on functions only; with -p, print their definitions',
  }),
  new Argument('-F', { action: 'store_true', help: 'print function names only' }),
  new Argument('-g', { action: 'store_true', help: 'make NAME global even inside a function' }),
  new Argument('-i', {
    action: 'store_true',
    help: 'make each NAME an integer, assigned arithmetically',
  }),
  new Argument('-I', {
    action: 'store_true',
    help: "inside a function, start from an outer variable's attributes",
  }),
  new Argument('-l', { action: 'store_true', help: 'lowercase each value as it is assigned' }),
  new Argument('-n', {
    action: 'store_true',
    help: 'make NAME a reference to the variable its value names',
  }),
  new Argument('-p', {
    action: 'store_true',
    help: 'print each NAME with its attributes and value',
  }),
  new Argument('-r', { action: 'store_true', help: 'make each NAME read-only' }),
  new Argument('-t', { action: 'store_true', help: 'give each NAME the trace attribute' }),
  new Argument('-u', { action: 'store_true', help: 'uppercase each value as it is assigned' }),
  new Argument('-x', { action: 'store_true', help: 'export each NAME' }),
]

const DECLARE_TEXT =
  "Gives each NAME the attributes its options name and assigns VALUE when one is given. With no NAME, prints the variables that have those attributes. Writing `+' in place of `-' removes an attribute. Inside a function, each NAME is local to it, as with `local', unless -g is given."

const DECLARE_STATUS = '0 unless an option or an assignment is invalid.'

const MAPFILE_OPTIONS = [
  new Argument('-d', { metavar: 'delim', help: 'end each line at DELIM rather than at a newline' }),
  new Argument('-n', { metavar: 'count', help: 'read at most COUNT lines; 0 reads them all' }),
  new Argument('-O', {
    metavar: 'origin',
    help: 'store the first line at index ORIGIN rather than 0',
  }),
  new Argument('-s', { metavar: 'count', help: 'skip the first COUNT lines' }),
  new Argument('-t', {
    action: 'store_true',
    help: 'drop the delimiter from the end of each line',
  }),
  new Argument('-u', {
    metavar: 'fd',
    help: 'read from file descriptor FD rather than standard input',
  }),
  new Argument('-C', { metavar: 'callback', help: 'run CALLBACK every QUANTUM lines' }),
  new Argument('-c', {
    metavar: 'quantum',
    help: 'how many lines go between CALLBACK runs; 5000 by default',
  }),
  new Argument('texts', { metavar: '', nargs: '*' }),
]

const MAPFILE_TEXT =
  'Reads lines from standard input into the indexed array ARRAY, or MAPFILE when no ARRAY is named, one line per element.'

const MAPFILE_STATUS =
  '0 unless an option is invalid or ARRAY is read-only or not an indexed array.'

const SOURCE = new CommandSpec({
  description:
    'Run the commands of a file in the current shell.\n\n' +
    'Reads FILENAME and runs its commands in this shell, so the variables, functions and working directory they set stay set. ARGUMENTS, when given, are the positional parameters while it runs.',
  epilog: 'The status of the last command FILENAME ran, or failure when it cannot be read.',
})

// The grammar of each command the shell runs itself, and what `help`,
// `NAME --help` and `man` say of it: the first paragraph of the description
// is its summary, the epilog its exit status. The wrapper builtins and `read`
// and `mapfile` scan their options from it too. Null prototype: `help` and
// `man` look names up as typed, so `toString` must miss.
export const SHELL_SPECS = Object.freeze(
  Object.assign(Object.create(null) as Record<string, CommandSpec | undefined>, {
    xargs: new CommandSpec({
      description: 'Build and run command lines from standard input.',
      arguments: [
        new Argument(['-0', '--null'], {
          action: 'store_true',
          help: 'Input items are terminated by NUL.',
        }),
        new Argument(['-a', '--arg-file'], {
          help: 'Read items from this file, not standard input.',
        }),
        new Argument(['-d', '--delimiter'], {
          help: 'Input items are separated by this character.',
        }),
        new Argument('-E', { help: 'Stop reading at this logical end-of-file string.' }),
        new Argument(['-e', '--eof'], {
          nargs: '?',
          attachedOnly: true,
          help: 'Same as -E; no string turns it off.',
        }),
        new Argument('-I', {
          help: 'Replace this string in the initial arguments with each input line.',
        }),
        new Argument(['-i', '--replace'], {
          nargs: '?',
          attachedOnly: true,
          help: 'Same as -I, with {} when no string is attached.',
        }),
        new Argument('-L', { help: 'Use at most N non-blank input lines per command line.' }),
        new Argument(['-l', '--max-lines'], {
          nargs: '?',
          attachedOnly: true,
          help: 'Same as -L, with 1 when no count is attached.',
        }),
        new Argument(['-n', '--max-args'], { help: 'Use at most N arguments per command line.' }),
        new Argument(['-o', '--open-tty'], {
          action: 'store_true',
          help: 'Reopen stdin as the terminal in each command (there is no terminal, so this fails).',
        }),
        new Argument(['-p', '--interactive'], {
          action: 'store_true',
          help: 'Prompt before running each command (there is no terminal, so this fails).',
        }),
        new Argument(['-r', '--no-run-if-empty'], {
          action: 'store_true',
          help: 'Do not run the command on empty input.',
        }),
        new Argument(['-s', '--max-chars'], { help: 'Limit a command line to N bytes.' }),
        new Argument(['-t', '--verbose'], {
          action: 'store_true',
          help: 'Print each command on stderr before running it.',
        }),
        new Argument('--show-limits', {
          action: 'store_true',
          help: 'Show the command-line length limits.',
        }),
        new Argument(['-x', '--exit'], {
          action: 'store_true',
          help: 'Exit if a command line exceeds the size limit.',
        }),
        new Argument(['-P', '--max-procs'], {
          help: 'Run up to N commands at a time; 0 runs them all at once.',
        }),
        new Argument('--process-slot-var', {
          help: "Set this variable to each command's slot number.",
        }),
        VERSION_OPTION,
        HELP_OPTION,
        new Argument('texts', { metavar: '', nargs: '*' }),
      ],
    }),
    timeout: new CommandSpec({
      description: 'Run a command with a time limit.',
      arguments: [
        new Argument(['-f', '--foreground'], {
          action: 'store_true',
          help: 'Signal only the command, not its process group.',
        }),
        new Argument(['-k', '--kill-after'], {
          help: 'Also send KILL this long after the first signal.',
        }),
        new Argument(['-p', '--preserve-status'], {
          action: 'store_true',
          help: "Exit with the command's status even when it times out.",
        }),
        new Argument(['-s', '--signal'], { help: 'Signal to send on timeout (default TERM).' }),
        new Argument(['-v', '--verbose'], {
          action: 'store_true',
          help: 'Report each signal sent on stderr.',
        }),
        HELP_OPTION,
        VERSION_OPTION,
        new Argument('texts', { metavar: '', nargs: '*' }),
      ],
    }),
    man: new CommandSpec({
      description: 'Show the manual page of a command.',
      epilog:
        "Shows the manual page of each PAGE: what the command does, how to call it and its options. The pages are those of the shell's own commands, of the commands each mount provides and of the installed CLIs, where a subcommand has a page of its own, named after its path with hyphens. Every page is in section 1.",
      arguments: [
        new Argument(['-a', '--all'], {
          action: 'store_true',
          help: 'show every page that matches PAGE',
        }),
        new Argument(['-f', '--whatis'], {
          action: 'store_true',
          help: 'print the summary line of each PAGE',
        }),
        new Argument(['-k', '--apropos'], {
          action: 'store_true',
          help: 'search the names and summaries of every page',
        }),
        new Argument(['-?', '-h', '--help'], { action: 'store_true', help: 'print this list' }),
        new Argument('--usage', { action: 'store_true', help: 'print the usage line' }),
        new Argument('pages', { nargs: '*', metavar: 'PAGE' }),
      ],
    }),
    '(( ... ))': new CommandSpec({
      description:
        'Evaluate an arithmetic expression.\n\n' +
        "Evaluates EXPRESSION with the shell's integer arithmetic, the same rules `let' follows.",
      epilog: '0 when EXPRESSION is not zero, 1 when it is zero.',
    }),
    '.': SOURCE,
    ':': new CommandSpec({
      description: 'Do nothing, successfully.\n\n' + 'Expands its arguments and does nothing else.',
      epilog: 'Always 0.',
    }),
    '[': new CommandSpec({
      description:
        'Evaluate a conditional expression.\n\n' +
        "Works as `test' does, but its last argument must be a literal `]'.",
      epilog: '0 when EXPR is true, 1 when it is false, 2 when it is invalid.',
    }),
    '[[ ... ]]': new CommandSpec({
      description:
        'Evaluate a conditional expression, without word splitting.\n\n' +
        "Evaluates EXPRESSION, built from the tests `test' knows, from `==' and `!=' with a glob pattern on the right, from `=~' with an extended regular expression on the right, and from `!', `&&', `||' and parentheses. The words inside are neither split nor expanded as globs.",
      epilog: '0 when EXPRESSION is true, 1 when it is false.',
    }),
    alias: new CommandSpec({
      description:
        'Define or print aliases.\n\n' +
        'With NAME=VALUE, defines an alias: when a command starts with NAME, the shell reads VALUE in its place. With NAME alone, prints that alias. With no arguments, prints every alias.',
      epilog: '0 unless a NAME has no alias.',
      arguments: [
        new Argument('-p', {
          action: 'store_true',
          help: 'print every alias in a form the shell can read back',
        }),
      ],
    }),
    break: new CommandSpec({
      description:
        'Leave a for, while, until or select loop.\n\n' +
        'Leaves the innermost enclosing loop, or the N-th one out when N is given.',
      epilog: '0 unless N is less than 1.',
    }),
    case: new CommandSpec({
      description:
        'Run the commands of the first pattern that matches.\n\n' +
        "Compares WORD with each PATTERN in turn, using the shell's glob syntax, and runs the COMMANDS of the first that matches. `|' separates patterns that lead to the same COMMANDS.",
      epilog: 'The status of the last command run, or 0 when no pattern matches.',
    }),
    cd: new CommandSpec({
      description:
        'Change the working directory.\n\n' +
        "Makes DIR the working directory, or $HOME when no DIR is given. `cd -' goes back to $OLDPWD.",
      epilog: '0 when the directory changed, otherwise non-zero.',
      arguments: [
        new Argument('-L', {
          action: 'store_true',
          help: 'keep symbolic links in the new path (the default)',
        }),
        new Argument('-P', {
          action: 'store_true',
          help: 'resolve symbolic links in the new path',
        }),
        new Argument('-e', {
          action: 'store_true',
          help: 'with -P, fail when the new path cannot be resolved',
        }),
        new Argument('-@', { action: 'store_true', help: 'accepted, with no effect' }),
      ],
    }),
    command: new CommandSpec({
      description:
        'Run a command, passing over shell functions, or describe it.\n\n' +
        'Runs COMMAND with its ARGs even when a shell function has the same name.',
      epilog: 'The status of COMMAND, or 127 when it cannot be found.',
      arguments: [
        new Argument('-p', {
          action: 'store_true',
          help: 'search a default PATH that finds the standard tools',
        }),
        new Argument('-v', {
          action: 'store_true',
          help: 'print the word or path the shell would run',
        }),
        new Argument('-V', {
          action: 'store_true',
          help: 'describe in words what the shell would run',
        }),
      ],
    }),
    continue: new CommandSpec({
      description:
        'Start the next pass of a for, while, until or select loop.\n\n' +
        "Skips the rest of the innermost enclosing loop's body, or of the N-th loop out when N is given.",
      epilog: '0 unless N is less than 1.',
    }),
    declare: new CommandSpec({
      description: 'Set variables and their attributes.\n\n' + DECLARE_TEXT,
      epilog: DECLARE_STATUS,
      arguments: DECLARE_OPTIONS,
    }),
    disown: new CommandSpec({
      description:
        "Remove jobs from the shell's job table.\n\n" +
        'Removes each JOBSPEC, or the current job when none is named, so the shell no longer reports or waits on it.',
      epilog: '0 unless an option or a JOBSPEC is invalid.',
      arguments: [
        new Argument('-a', { action: 'store_true', help: 'remove every job' }),
        new Argument('-h', {
          action: 'store_true',
          help: 'keep the job, but do not hang it up when the shell exits',
        }),
        new Argument('-r', { action: 'store_true', help: 'remove running jobs only' }),
      ],
    }),
    echo: new CommandSpec({
      description:
        'Write the arguments to standard output.\n\n' +
        'Prints the ARGs separated by single spaces, then a newline.',
      epilog: '0 unless writing fails.',
      arguments: [
        new Argument('-n', { action: 'store_true', help: 'leave out the final newline' }),
        new Argument('-e', {
          action: 'store_true',
          help: 'interpret backslash escapes such as \\n and \\t',
        }),
        new Argument('-E', {
          action: 'store_true',
          help: 'leave backslash escapes as written (the default)',
        }),
      ],
    }),
    eval: new CommandSpec({
      description:
        'Run the arguments as a command line.\n\n' +
        'Joins the ARGs with spaces and runs the result as a command line in the current shell.',
      epilog: 'The status of that line, or 0 when it is empty.',
    }),
    exec: new CommandSpec({
      description:
        'Run a command in place of the shell, or redirect the shell.\n\n' +
        'With COMMAND, runs it in place of the shell, so nothing after it on the line runs. With only redirections, applies them to the shell itself, for every command that follows.',
      epilog: 'The status of COMMAND, or 0 when only redirections are given.',
      arguments: [
        new Argument('-c', { action: 'store_true', help: 'run COMMAND with an empty environment' }),
      ],
    }),
    exit: new CommandSpec({
      description:
        'Leave the shell.\n\n' +
        'Ends the shell with status N, or with the status of the last command when N is not given.',
    }),
    export: new CommandSpec({
      description:
        'Put variables in the environment of the commands it runs.\n\n' +
        'Marks each NAME for export, so every command the shell runs sees it, and assigns VALUE when one is given. With no NAME, prints every exported variable.',
      epilog: '0 unless an option or a NAME is invalid.',
      arguments: [
        new Argument('-f', { action: 'store_true', help: 'each NAME is a shell function' }),
        new Argument('-n', { action: 'store_true', help: 'take the export mark off each NAME' }),
        new Argument('-p', {
          action: 'store_true',
          help: 'print every exported variable in a reusable form',
        }),
      ],
    }),
    false: new CommandSpec({
      description: 'Do nothing, unsuccessfully.',
      epilog: 'Always 1.',
    }),
    fg: new CommandSpec({
      description:
        'Bring a job to the foreground.\n\n' +
        'Makes JOB_SPEC, or the current job, the foreground job and waits for it.',
      epilog: 'The status of the job, or failure when JOB_SPEC is invalid.',
    }),
    for: new CommandSpec({
      description:
        'Run commands once for each word of a list.\n\n' +
        "Sets NAME to each of WORDS in turn and runs COMMANDS. Without `in WORDS', it goes through the positional parameters.",
      epilog: 'The status of the last command run.',
    }),
    'for ((': new CommandSpec({
      description:
        'Loop under the control of arithmetic expressions.\n\n' +
        'Evaluates EXP1 once, then runs COMMANDS and evaluates EXP3 for as long as EXP2 is not zero. An expression left out counts as 1.',
      epilog: 'The status of the last command run.',
    }),
    function: new CommandSpec({
      description:
        'Define a shell function.\n\n' +
        "Makes NAME a command that runs COMMANDS. While it runs, its arguments are the positional parameters, and `return' ends it.",
      epilog: '0 unless NAME is read-only.',
    }),
    getopts: new CommandSpec({
      description:
        'Parse options from the arguments.\n\n' +
        "Reads the next option from the ARGs, or from the positional parameters, and puts its letter in NAME. OPTSTRING lists the letters; one followed by `:' takes a value, which goes in OPTARG. OPTIND holds the index of the next argument to read. A `:' at the start of OPTSTRING turns error messages off.",
      epilog: '0 when an option was found, 1 at the end of the options or on an error.',
    }),
    help: new CommandSpec({
      description:
        "Show how to use the shell's own commands.\n\n" +
        'Shows the commands that match each PATTERN, or lists every one when no PATTERN is given. A PATTERN matches the names it begins, or the names it matches as a glob.',
      epilog: '0 unless no command matches a PATTERN or an option is invalid.',
      arguments: [
        new Argument('-d', { action: 'store_true', help: "print each command's one-line summary" }),
        new Argument('-m', {
          action: 'store_true',
          help: "print each command's help as a manual page",
        }),
        new Argument('-s', { action: 'store_true', help: "print each command's synopsis only" }),
      ],
    }),
    history: specOf('history'),
    if: new CommandSpec({
      description:
        'Run commands when a condition holds.\n\n' +
        "Runs the `if' COMMANDS and, when they succeed, the `then' COMMANDS. Otherwise each `elif' is tried in turn, and the `else' COMMANDS run when none succeeds.",
      epilog: 'The status of the last command run, or 0 when no branch ran.',
    }),
    jobs: new CommandSpec({
      description: "List the shell's jobs.\n\n" + 'Lists every job, or the JOBSPECs named.',
      epilog: '0 unless an option or a JOBSPEC is invalid.',
      arguments: [
        new Argument('-l', { action: 'store_true', help: "add each job's process ID" }),
        new Argument('-n', {
          action: 'store_true',
          help: 'only jobs whose state changed since last reported',
        }),
        new Argument('-p', { action: 'store_true', help: 'print process IDs only' }),
        new Argument('-r', { action: 'store_true', help: 'running jobs only' }),
        new Argument('-s', { action: 'store_true', help: 'stopped jobs only' }),
      ],
    }),
    kill: new CommandSpec({
      description:
        'Send a signal to processes or jobs.\n\n' +
        'Sends SIGTERM, or the signal named by an option, to each PID or JOBSPEC.',
      epilog: '0 when every signal was sent.',
      arguments: [
        new Argument('-s', { metavar: 'sig', help: 'the signal to send, by name' }),
        new Argument('-n', { metavar: 'sig', help: 'the signal to send, by number' }),
        new Argument('-l', {
          action: 'store_true',
          help: 'list the signal names, or name the numbers given',
        }),
      ],
    }),
    let: new CommandSpec({
      description:
        'Evaluate arithmetic expressions.\n\n' +
        "Evaluates each ARG as an arithmetic expression, in which variables are named without `$'.",
      epilog: '0 when the last ARG is not zero, 1 when it is.',
    }),
    local: new CommandSpec({
      description:
        'Define variables local to a function.\n\n' +
        "Creates each NAME as a variable that lasts only as long as the function running it, with any option `declare' takes.",
      epilog: '0 unless used outside a function or given an invalid NAME.',
    }),
    mapfile: new CommandSpec({
      description: 'Read lines into an indexed array.\n\n' + MAPFILE_TEXT,
      epilog: MAPFILE_STATUS,
      arguments: MAPFILE_OPTIONS,
    }),
    printf: new CommandSpec({
      description:
        'Print arguments under the control of a format.\n\n' +
        'Prints the ARGUMENTS as FORMAT describes, using the conversions printf(1) knows, plus %b, which expands backslash escapes in its argument, and %q, which quotes its argument for the shell to read back. FORMAT is used again for as long as arguments remain.',
      epilog: '0 unless an option is invalid or writing fails.',
      arguments: [
        new Argument('-v', {
          metavar: 'var',
          help: 'store the output in VAR instead of printing it',
        }),
      ],
    }),
    pwd: new CommandSpec({
      description: 'Print the working directory.',
      epilog: '0 unless an option is invalid.',
      arguments: [
        new Argument('-L', {
          action: 'store_true',
          help: 'print it as reached, symbolic links kept (the default)',
        }),
        new Argument('-P', { action: 'store_true', help: 'print it with symbolic links resolved' }),
      ],
    }),
    read: new CommandSpec({
      description:
        'Read one line and split it into fields.\n\n' +
        'Reads a line from standard input, splits it at the characters of $IFS, and assigns the fields to the NAMEs in turn, the last NAME taking what remains. With no NAME, the line goes into REPLY.',
      epilog: '0 unless input ends, the read times out, or an option is invalid.',
      arguments: [
        new Argument('-a', { metavar: 'array', help: 'assign the fields to ARRAY, from index 0' }),
        new Argument('-d', { metavar: 'delim', help: 'read up to DELIM rather than a newline' }),
        new Argument('-e', { action: 'store_true', help: 'accepted, with no effect' }),
        new Argument('-i', { metavar: 'text', help: 'accepted, with no effect' }),
        new Argument('-n', {
          metavar: 'nchars',
          help: 'stop after NCHARS characters or at the delimiter',
        }),
        new Argument('-N', { metavar: 'nchars', help: 'read exactly NCHARS characters' }),
        new Argument('-p', { metavar: 'prompt', help: 'print PROMPT on standard error first' }),
        new Argument('-r', { action: 'store_true', help: 'take backslashes literally' }),
        new Argument('-s', { action: 'store_true', help: 'accepted, with no effect' }),
        new Argument('-t', { metavar: 'timeout', help: 'give up after TIMEOUT seconds' }),
        new Argument('-u', { metavar: 'fd', help: 'read from file descriptor FD' }),
        new Argument('texts', { metavar: '', nargs: '*' }),
      ],
    }),
    readarray: new CommandSpec({
      description: "Read lines into an indexed array; the same as `mapfile'.\n\n" + MAPFILE_TEXT,
      epilog: MAPFILE_STATUS,
      arguments: MAPFILE_OPTIONS,
    }),
    readonly: new CommandSpec({
      description:
        'Make variables read-only.\n\n' +
        'Makes each NAME read-only, assigning VALUE first when one is given. With no NAME, prints every read-only variable.',
      epilog: '0 unless an option or a NAME is invalid.',
      arguments: [
        new Argument('-a', { action: 'store_true', help: 'each NAME is an indexed array' }),
        new Argument('-A', { action: 'store_true', help: 'each NAME is an associative array' }),
        new Argument('-f', { action: 'store_true', help: 'each NAME is a shell function' }),
        new Argument('-p', {
          action: 'store_true',
          help: 'print every read-only variable in a reusable form',
        }),
      ],
    }),
    return: new CommandSpec({
      description:
        'Leave a function or a sourced file.\n\n' +
        'Ends the running function or sourced file with status N, or with the status of the last command when N is not given.',
      epilog: 'N, or failure when no function or sourced file is running.',
    }),
    select: new CommandSpec({
      description:
        'Choose words from a numbered menu.\n\n' +
        "Prints WORDS as a numbered menu on standard error, then reads a line from standard input. NAME gets the word chosen, REPLY the line, and COMMANDS run; then the menu comes back, until `break' or the end of input.",
      epilog: 'The status of the last command run.',
    }),
    set: new CommandSpec({
      description:
        'Set shell options and positional parameters.\n\n' +
        "With no arguments, prints every shell variable. Each option turns a behaviour on with `-' and off with `+'. The ARGs that follow become the positional parameters.\n\n" +
        "After `--', the ARGs are the positional parameters even when they begin with a dash, and with no ARG the positional parameters are unset. A lone `-' ends the options too, and turns -v and -x off.",
      epilog: '0 unless an option is invalid.',
      arguments: [
        new Argument('-a', {
          action: 'store_true',
          help: 'export every variable that is assigned',
        }),
        new Argument('-b', { action: 'store_true', help: 'report finished jobs at once' }),
        new Argument('-e', { action: 'store_true', help: 'leave the shell when a command fails' }),
        new Argument('-f', { action: 'store_true', help: 'turn off pathname expansion' }),
        new Argument('-h', { action: 'store_true', help: 'remember where commands are found' }),
        new Argument('-k', {
          action: 'store_true',
          help: "take assignments anywhere in a command's words",
        }),
        new Argument('-m', { action: 'store_true', help: 'turn on job control' }),
        new Argument('-n', { action: 'store_true', help: 'read commands without running them' }),
        new Argument('-o', { metavar: 'name', help: 'turn on the option called NAME' }),
        new Argument('-p', { action: 'store_true', help: 'privileged mode' }),
        new Argument('-t', { action: 'store_true', help: 'leave after one command' }),
        new Argument('-u', { action: 'store_true', help: 'treat an unset variable as an error' }),
        new Argument('-v', { action: 'store_true', help: 'print each line as it is read' }),
        new Argument('-x', { action: 'store_true', help: 'print each command as it runs' }),
        new Argument('-B', { action: 'store_true', help: 'turn on brace expansion' }),
        new Argument('-C', { action: 'store_true', help: "refuse to overwrite files with `>'" }),
        new Argument('-E', { action: 'store_true', help: 'pass the ERR trap on to functions' }),
        new Argument('-H', { action: 'store_true', help: "turn on `!' history expansion" }),
        new Argument('-P', {
          action: 'store_true',
          help: 'resolve symbolic links when changing directory',
        }),
        new Argument('-T', {
          action: 'store_true',
          help: 'pass the DEBUG and RETURN traps on to functions',
        }),
      ],
    }),
    shift: new CommandSpec({
      description:
        'Shift the positional parameters.\n\n' +
        'Drops the first N positional parameters, 1 by default, and renumbers the rest from 1.',
      epilog: '0 unless N is negative or larger than $#.',
    }),
    shopt: new CommandSpec({
      description:
        'Set and unset shell options.\n\n' +
        'Turns each OPTNAME on or off, or prints its state. With no OPTNAME, prints every option.',
      epilog:
        'When printing, 0 when every OPTNAME is on; otherwise 0 unless an OPTNAME is invalid.',
      arguments: [
        new Argument('-o', { action: 'store_true', help: "each OPTNAME is an option of `set -o'" }),
        new Argument('-p', { action: 'store_true', help: 'print in a reusable form' }),
        new Argument('-q', { action: 'store_true', help: 'print nothing; the status tells' }),
        new Argument('-s', { action: 'store_true', help: 'turn each OPTNAME on' }),
        new Argument('-u', { action: 'store_true', help: 'turn each OPTNAME off' }),
      ],
    }),
    source: SOURCE,
    test: new CommandSpec({
      description:
        'Evaluate a conditional expression.\n\n' +
        "Evaluates EXPR, made of file tests such as -e, -f, -d, -r, -w, -x and -s, string tests (-z, -n, = and !=) and integer comparisons (-eq, -ne, -lt, -le, -gt and -ge), joined with `!', -a and -o.",
      epilog: '0 when EXPR is true, 1 when it is false, 2 when it is invalid.',
    }),
    time: new CommandSpec({
      description:
        'Report how long a pipeline takes.\n\n' +
        'Runs PIPELINE, then prints the real time it took and the user and system time it used on standard error.',
      epilog: 'The status of PIPELINE.',
      arguments: [
        new Argument('-p', {
          action: 'store_true',
          help: 'print the times in the portable format',
        }),
      ],
    }),
    trap: new CommandSpec({
      description:
        'Run commands when the shell meets signals or events.\n\n' +
        "Runs ARG when a SIGNAL_SPEC arrives. An empty ARG ignores the signals; `-' puts back what they did before. EXIT runs as the shell leaves, ERR after a command fails, DEBUG before each command and RETURN as a function or sourced file ends.",
      epilog: '0 unless a SIGNAL_SPEC is invalid.',
      arguments: [
        new Argument('-l', { action: 'store_true', help: 'list the signal names and numbers' }),
        new Argument('-p', { action: 'store_true', help: 'print the traps that are set' }),
      ],
    }),
    true: new CommandSpec({
      description: 'Do nothing, successfully.',
      epilog: 'Always 0.',
    }),
    type: new CommandSpec({
      description:
        'Tell how the shell would run a name.\n\n' +
        'Tells, for each NAME, whether it is an alias, a keyword, a function, a builtin or a file, and where.',
      epilog: '0 when every NAME is found.',
      arguments: [
        new Argument('-a', {
          action: 'store_true',
          help: 'every place NAME is found, not only the first',
        }),
        new Argument('-f', { action: 'store_true', help: 'pass over shell functions' }),
        new Argument('-p', {
          action: 'store_true',
          help: 'print the file NAME runs, if it is one',
        }),
        new Argument('-P', {
          action: 'store_true',
          help: 'print the file NAME would run, searching PATH',
        }),
        new Argument('-t', {
          action: 'store_true',
          help: 'print one word: alias, keyword, function, builtin or file',
        }),
      ],
    }),
    typeset: new CommandSpec({
      description: "Set variables and their attributes; the same as `declare'.\n\n" + DECLARE_TEXT,
      epilog: DECLARE_STATUS,
      arguments: DECLARE_OPTIONS,
    }),
    umask: new CommandSpec({
      description:
        'Print or set the file mode creation mask.\n\n' +
        "Sets the mask to MODE, in octal or in chmod's symbolic form, or prints it when no MODE is given.",
      epilog: '0 unless MODE or an option is invalid.',
      arguments: [
        new Argument('-p', { action: 'store_true', help: 'print the mask in a reusable form' }),
        new Argument('-S', { action: 'store_true', help: 'print the mask symbolically' }),
      ],
    }),
    unalias: new CommandSpec({
      description: 'Remove aliases.',
      epilog: '0 unless a NAME is not an alias.',
      arguments: [new Argument('-a', { action: 'store_true', help: 'remove every alias' })],
    }),
    unset: new CommandSpec({
      description:
        'Remove variables and functions.\n\n' +
        'Removes each NAME, as a variable, or as a function when no variable has that name.',
      epilog: '0 unless a NAME is read-only.',
      arguments: [
        new Argument('-f', { action: 'store_true', help: 'each NAME is a function' }),
        new Argument('-v', { action: 'store_true', help: 'each NAME is a variable' }),
        new Argument('-n', {
          action: 'store_true',
          help: 'remove the reference NAME itself, not what it names',
        }),
      ],
    }),
    until: new CommandSpec({
      description:
        'Run commands for as long as a condition fails.\n\n' +
        'Runs COMMANDS-2 for as long as COMMANDS fail.',
      epilog: 'The status of the last command run.',
    }),
    wait: new CommandSpec({
      description:
        'Wait for jobs and return their status.\n\n' +
        'Waits for each ID, a process ID or a job spec, and returns its status. With no ID, waits for every job the shell started and returns 0. Only a job this shell started can be waited for.',
      epilog: 'The status of the last ID, or failure when an ID or an option is invalid.',
      arguments: [
        new Argument('-f', {
          action: 'store_true',
          help: 'wait until each ID ends, not only until it changes state',
        }),
        new Argument('-n', {
          action: 'store_true',
          help: 'wait for the next job to end and return its status',
        }),
        new Argument('-p', {
          metavar: 'var',
          help: 'store in VAR the ID whose status is returned',
        }),
      ],
    }),
    while: new CommandSpec({
      description:
        'Run commands for as long as a condition holds.\n\n' +
        'Runs COMMANDS-2 for as long as COMMANDS succeed.',
      epilog: 'The status of the last command run.',
    }),
    '{ ... }': new CommandSpec({
      description:
        'Run a list of commands as a group.\n\n' +
        'Runs COMMANDS in the current shell, so one redirection applies to all of them.',
      epilog: 'The status of the last command run.',
    }),
  }),
)

/**
 * Result of a strict leading-option scan for a shell builtin.
 *
 * Wrapper builtins (xargs, timeout) stop option parsing at the first
 * operand, since everything after it belongs to the wrapped command;
 * the mount-command parser scans the whole line and warns-ignores
 * unknown flags, which is wrong on both counts here. The builtin owns
 * the error message and exit code (GNU shapes differ per tool), so
 * the parse only reports what went wrong. An optional-value option given
 * bare is `true` in `flags`; `given` lists every option in the order it
 * was given, for a builtin whose options act in turn (xargs -I, -L and
 * -n cancel one another). `candidates` names the long options an
 * ambiguous abbreviation in `invalid` could mean, in declaration order,
 * and is empty when `invalid` names none. `needsValue` is the short
 * char, or the long token with its dashes; `unexpectedValue` is a
 * no-argument long option given a value, as its full spelling and the
 * value (`--null=x`).
 */
export interface ShellParse {
  flags: Record<string, string | boolean>
  given: [string, string | boolean][]
  operands: string[]
  invalid: string | null
  candidates: readonly string[]
  needsValue: string | null
  unexpectedValue: string | null
}

type ShellRefusal = Partial<
  Pick<ShellParse, 'invalid' | 'candidates' | 'needsValue' | 'unexpectedValue'>
>

/**
 * Scan leading options the way getopt does for a shell builtin.
 *
 * An optional-value option takes its value only when attached (`-iR`,
 * `--replace=R`), as getopt's `::` does, and a long option may be
 * abbreviated to any prefix that names one option, as getopt_long reads
 * it; an empty name (`--=x`) prefixes every one.
 */
export function parseShellOptions(spec: CommandSpec, argv: readonly string[]): ShellParse {
  const shortBool = new Set<string>()
  const shortValue = new Set<string>()
  const shortOptional = new Set<string>()
  const longBool = new Set<string>()
  const longValue = new Set<string>()
  const longOptional = new Set<string>()
  const alias = new Map<string, string>()
  for (const opt of compileSpec(spec).options) {
    const [, longName] = optionSpellings(opt)
    const shorts = opt.names.filter((n) => !n.startsWith('--')).map((n) => n.slice(1))
    const long = longName?.replace(/^-+/, '') ?? null
    const name = shorts[0] ?? long ?? ''
    for (const short of shorts) {
      ;(opt.action === 'store_true' || opt.action === 'count'
        ? shortBool
        : opt.nargs === '?'
          ? shortOptional
          : shortValue
      ).add(short)
      alias.set(short, name)
    }
    if (long !== null) {
      ;(opt.action === 'store_true' || opt.action === 'count'
        ? longBool
        : opt.nargs === '?'
          ? longOptional
          : longValue
      ).add(long)
      alias.set(long, name)
    }
  }
  const compiled = compileSpec(spec)
  const flags: Record<string, string | boolean> = {}
  const given: [string, string | boolean][] = []
  const record = (key: string, value: string | boolean): void => {
    flags[key] = value
    given.push([key, value])
  }
  const done = (operands: readonly string[], refusal: ShellRefusal = {}): ShellParse => ({
    flags,
    given,
    operands: [...operands],
    invalid: null,
    candidates: [],
    needsValue: null,
    unexpectedValue: null,
    ...refusal,
  })
  let i = 0
  while (i < argv.length) {
    const tok = argv[i]
    if (tok === undefined) break
    if (tok === '--') {
      i += 1
      break
    }
    if (tok.startsWith('--') && tok.length > 2) {
      const eq = tok.indexOf('=')
      const typed = eq >= 0 ? tok.slice(0, eq) : tok
      const matches = typed === '--' ? compiled.longSpellings : expandLong(compiled, typed)
      const match = matches[0]
      if (matches.length !== 1 || match === undefined) {
        return done(argv.slice(i + 1), { invalid: tok, candidates: matches })
      }
      const name = match.slice(2)
      if (longBool.has(name)) {
        if (eq >= 0) {
          return done(argv.slice(i + 1), { unexpectedValue: `--${name}=${tok.slice(eq + 1)}` })
        }
        record(alias.get(name) ?? name, true)
      } else if (longOptional.has(name)) {
        record(alias.get(name) ?? name, eq >= 0 ? tok.slice(eq + 1) : true)
      } else if (longValue.has(name)) {
        if (eq >= 0) {
          record(alias.get(name) ?? name, tok.slice(eq + 1))
        } else {
          const value = argv[i + 1]
          if (value === undefined) return done(argv.slice(i + 1), { needsValue: `--${name}` })
          i += 1
          record(alias.get(name) ?? name, value)
        }
      }
      i += 1
      continue
    }
    if (tok.startsWith('-') && tok.length > 1) {
      const chars = tok.slice(1)
      let j = 0
      while (j < chars.length) {
        const ch = chars[j]
        if (ch === undefined) break
        if (shortBool.has(ch)) {
          record(alias.get(ch) ?? ch, true)
          j += 1
          continue
        }
        if (shortOptional.has(ch)) {
          const attached = chars.slice(j + 1)
          record(alias.get(ch) ?? ch, attached === '' ? true : attached)
          break
        }
        if (shortValue.has(ch)) {
          const rest = chars.slice(j + 1)
          if (rest !== '') {
            record(alias.get(ch) ?? ch, rest)
          } else {
            const value = argv[i + 1]
            if (value === undefined) {
              return done(argv.slice(i + 1), { needsValue: ch })
            }
            i += 1
            record(alias.get(ch) ?? ch, value)
          }
          break
        }
        return done(argv.slice(i + 1), { invalid: ch })
      }
      i += 1
      continue
    }
    break
  }
  return done(argv.slice(i))
}
