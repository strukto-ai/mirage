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

export const SPECS: Record<string, CommandSpec> = {
  awk: new CommandSpec({
    options: [
      new Option({ short: '-F', type: 'str' }),
      new Option({ short: '-v', type: 'str', multiple: true }),
      new Option({ short: '-f', type: 'path', multiple: true }),
    ],
    positional: [new Operand({ type: 'str', providedBy: ['-f'] })],
    rest: new Operand({ type: 'path' }),
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
      // -G asks for the basic expressions grep already reads by default, so it
      // is accepted and changes nothing.
      new Option({ short: '-G' }),
      new Option({ short: '-o' }),
      new Option({ short: '-q' }),
      new Option({ short: '-H' }),
      new Option({ short: '-h' }),
      new Option({ short: '-m', type: 'str' }),
      new Option({ short: '-A', type: 'str' }),
      new Option({ short: '-B', type: 'str' }),
      new Option({ short: '-C', type: 'str' }),
      new Option({ short: '-e', type: 'str', multiple: true }),
      new Option({ short: '-f', type: 'path', multiple: true }),
      // Accepted no-ops: output is never a tty, so plain output is
      // exactly what GNU produces with --color=auto (#471).
      new Option({ long: '--color', type: 'str', valueOptional: true }),
      new Option({ long: '--colour', type: 'str', valueOptional: true }),
      new Option({ long: '--line-buffered' }),
    ],
    positional: [new Operand({ type: 'str', providedBy: ['-e', '-f'] })],
    rest: new Operand({ type: 'path' }),
  }),
  jq: new CommandSpec({
    options: [
      new Option({
        short: '-n',
        long: '--null-input',
        description: 'Use null as the single input value',
      }),
      new Option({
        short: '-R',
        long: '--raw-input',
        description: 'Read each line as a string instead of JSON',
      }),
      new Option({ short: '-s', long: '--slurp', description: 'Read all inputs into one array' }),
      new Option({
        short: '-c',
        long: '--compact-output',
        description: 'Compact instead of pretty-printed output',
      }),
      new Option({
        short: '-r',
        long: '--raw-output',
        description: 'Output strings without quotes or escapes',
      }),
      new Option({
        long: '--raw-output0',
        description: 'Implies -r and writes NUL after each output',
      }),
      new Option({
        short: '-j',
        long: '--join-output',
        description: 'Implies -r and writes no trailing newline',
      }),
      new Option({
        short: '-a',
        long: '--ascii-output',
        description: 'Escape non-ASCII characters in output',
      }),
      new Option({ short: '-S', long: '--sort-keys', description: 'Sort object keys on output' }),
      new Option({
        short: '-e',
        long: '--exit-status',
        description: 'Set the exit status from the last output',
      }),
      new Option({ long: '--tab', description: 'Indent with tabs' }),
      new Option({ long: '--indent', type: 'int', description: 'Indent with n spaces (max 7)' }),
      new Option({
        short: '-M',
        long: '--monochrome-output',
        description: 'Disable colored output (already the default)',
      }),
      new Option({
        long: '--unbuffered',
        description: 'Accepted for compatibility; output is one buffer',
      }),
      new Option({
        short: '-f',
        long: '--from-file',
        type: 'path',
        description: 'Read the filter from a file',
      }),
      new Option({
        long: '--stream',
        description: 'Read each input as its [path, leaf] events',
      }),
      new Option({
        long: '--seq',
        description: 'Read and write RS-delimited JSON text sequences',
      }),
      new Option({
        long: '--arg',
        type: 'str',
        pair: true,
        description: 'Set $name to a string value',
      }),
      new Option({
        long: '--argjson',
        type: 'str',
        pair: true,
        description: 'Set $name to a JSON value',
      }),
      new Option({
        long: '--rawfile',
        type: 'path',
        pair: true,
        description: "Set $name to a file's contents",
      }),
      new Option({
        long: '--slurpfile',
        type: 'path',
        pair: true,
        description: "Set $name to a file's documents, as an array",
      }),
      new Option({
        long: '--args',
        description: 'Read the remaining operands as positional string values',
      }),
      new Option({
        long: '--jsonargs',
        description: 'Read the remaining operands as positional JSON values',
      }),
      new Option({ short: '-h', long: '--help', description: 'Show this help and exit' }),
    ],
    // Without providedBy, `jq -f prog.jq data.json` would take data.json
    // as the filter and never read it as a file.
    positional: [new Operand({ type: 'str', providedBy: ['-f'] })],
    // --args and --jsonargs turn the operands after the program into
    // $ARGS.positional, so they stop being input files.
    rest: new Operand({ type: 'path', textWhen: ['--args', '--jsonargs'] }),
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
      new Option({ short: '-e', type: 'str', multiple: true }),
      new Option({ short: '-f', type: 'path', multiple: true }),
      new Option({ short: '-m', type: 'str' }),
      new Option({ short: '-A', type: 'str' }),
      new Option({ short: '-B', type: 'str' }),
      new Option({ short: '-C', type: 'str' }),
      new Option({ long: '--hidden' }),
      new Option({ long: '--type', type: 'str' }),
      new Option({ long: '--glob', type: 'str' }),
      // Accepted no-op like grep --color (#471).
      new Option({ long: '--color', type: 'str', valueOptional: true }),
    ],
    positional: [new Operand({ type: 'str', providedBy: ['-e', '-f'] })],
    rest: new Operand({ type: 'path' }),
  }),
  search: new CommandSpec({
    options: [
      new Option({ long: '--method', type: 'str' }),
      new Option({ long: '--top-k', type: 'str' }),
      new Option({ long: '--threshold', type: 'str' }),
    ],
    positional: [new Operand({ type: 'str' })],
    rest: new Operand({ type: 'path' }),
  }),
  sed: new CommandSpec({
    options: [
      new Option({ short: '-i' }),
      // -e takes a script and may repeat; multiple -e are joined with newlines.
      new Option({ short: '-e', type: 'str', multiple: true }),
      // -f reads the script from a file and may repeat (like grep -f); its value
      // is a PATH so it routes and is read from the mount.
      new Option({ short: '-f', type: 'path', multiple: true }),
      new Option({ short: '-n' }),
      new Option({ short: '-E' }),
      new Option({ short: '-r' }),
    ],
    // providedBy lists the flags that can supply this positional slot's value;
    // when any is present the parser skips the slot so the next word is not
    // mis-grabbed. For sed the first operand is the script (TEXT) only when
    // neither -e nor -f gave one (GNU). With -e/-f the slot is skipped and the
    // first operand reflows to a file path in rest.
    positional: [new Operand({ type: 'str', providedBy: ['-e', '-f'] })],
    rest: new Operand({ type: 'path' }),
  }),
  strings: new CommandSpec({
    options: [new Option({ short: '-n', type: 'str' })],
    rest: new Operand({ type: 'path' }),
  }),
  zgrep: new CommandSpec({
    options: [
      new Option({ short: '-i' }),
      new Option({ short: '-c' }),
      new Option({ short: '-l' }),
      new Option({ short: '-n' }),
      new Option({ short: '-v' }),
      new Option({ short: '-e', type: 'str', multiple: true }),
      new Option({ short: '-f', type: 'path', multiple: true }),
      new Option({ short: '-E' }),
      new Option({ short: '-G' }),
      new Option({ short: '-F' }),
      new Option({ short: '-H' }),
      new Option({ short: '-h' }),
      new Option({ short: '-m', type: 'str' }),
      new Option({ short: '-o' }),
      new Option({ short: '-q' }),
      new Option({ short: '-w' }),
    ],
    positional: [new Operand({ type: 'str', providedBy: ['-e', '-f'] })],
    rest: new Operand({ type: 'path' }),
  }),
}
