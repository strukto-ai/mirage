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

import { CommandSpec, Operand, OperandKind, Option } from './types.ts'

export function specOf(name: string): CommandSpec {
  const spec = BUILTIN_SPECS[name]
  if (spec === undefined) throw new Error(`no builtin spec: ${name}`)
  return spec
}

export const BUILTIN_SPECS: Readonly<Record<string, CommandSpec>> = Object.freeze({
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
    ],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  stat: new CommandSpec({
    options: [
      new Option({ short: '-c', valueKind: OperandKind.TEXT }),
      new Option({ short: '-f', valueKind: OperandKind.TEXT }),
    ],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  pwd: new CommandSpec({
    options: [new Option({ short: '-P' }), new Option({ short: '-L' })],
    rest: new Operand({ kind: OperandKind.TEXT }),
  }),
  find: new CommandSpec({
    options: [
      new Option({ short: '-name', valueKind: OperandKind.TEXT }),
      new Option({ short: '-type', valueKind: OperandKind.TEXT }),
      new Option({ short: '-maxdepth', valueKind: OperandKind.TEXT }),
      new Option({ short: '-size', valueKind: OperandKind.TEXT }),
      new Option({ short: '-mtime', valueKind: OperandKind.TEXT }),
      new Option({ short: '-iname', valueKind: OperandKind.TEXT }),
      new Option({ short: '-path', valueKind: OperandKind.TEXT }),
      new Option({ short: '-mindepth', valueKind: OperandKind.TEXT }),
      new Option({ short: '-print' }),
      new Option({ short: '-print0' }),
      new Option({ short: '-delete' }),
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
  du: new CommandSpec({
    options: [
      new Option({ short: '-h' }),
      new Option({ short: '-s' }),
      new Option({ short: '-a' }),
      new Option({ long: '--max-depth', valueKind: OperandKind.TEXT }),
      new Option({ short: '-c' }),
    ],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  cat: new CommandSpec({
    options: [new Option({ short: '-n' })],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  head: new CommandSpec({
    options: [
      new Option({ short: '-n', valueKind: OperandKind.TEXT, numericShorthand: true }),
      new Option({ short: '-c', valueKind: OperandKind.TEXT }),
    ],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  tail: new CommandSpec({
    options: [
      new Option({ short: '-n', valueKind: OperandKind.TEXT, numericShorthand: true }),
      new Option({ short: '-c', valueKind: OperandKind.TEXT }),
      new Option({ short: '-q' }),
      new Option({ short: '-v' }),
    ],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  wc: new CommandSpec({
    options: [
      new Option({ short: '-l' }),
      new Option({ short: '-w' }),
      new Option({ short: '-c' }),
      new Option({ short: '-m' }),
      new Option({ short: '-L' }),
    ],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  md5: new CommandSpec({ rest: new Operand({ kind: OperandKind.PATH }) }),
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
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  file: new CommandSpec({
    options: [new Option({ short: '-b' }), new Option({ short: '-i' })],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  python: new CommandSpec({
    options: [new Option({ short: '-c', valueKind: OperandKind.TEXT })],
    rest: new Operand({ kind: OperandKind.TEXT }),
  }),
  python3: new CommandSpec({
    options: [new Option({ short: '-c', valueKind: OperandKind.TEXT })],
    rest: new Operand({ kind: OperandKind.TEXT }),
  }),
  nl: new CommandSpec({
    options: [
      new Option({ short: '-b', valueKind: OperandKind.TEXT }),
      new Option({ short: '-v', valueKind: OperandKind.TEXT }),
      new Option({ short: '-i', valueKind: OperandKind.TEXT }),
      new Option({ short: '-w', valueKind: OperandKind.TEXT }),
      new Option({ short: '-s', valueKind: OperandKind.TEXT }),
    ],
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
      new Option({ short: '-e', valueKind: OperandKind.TEXT }),
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
      new Option({ short: '-m', valueKind: OperandKind.TEXT }),
      new Option({ short: '-A', valueKind: OperandKind.TEXT }),
      new Option({ short: '-B', valueKind: OperandKind.TEXT }),
      new Option({ short: '-C', valueKind: OperandKind.TEXT }),
      new Option({ long: '--hidden' }),
      new Option({ long: '--type', valueKind: OperandKind.TEXT }),
      new Option({ long: '--glob', valueKind: OperandKind.TEXT }),
    ],
    positional: [new Operand({ kind: OperandKind.TEXT })],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  sort: new CommandSpec({
    options: [
      new Option({ short: '-r' }),
      new Option({ short: '-n' }),
      new Option({ short: '-u' }),
      new Option({ short: '-f' }),
      new Option({ short: '-k', valueKind: OperandKind.TEXT }),
      new Option({ short: '-t', valueKind: OperandKind.TEXT }),
      new Option({ short: '-h' }),
      new Option({ short: '-V' }),
      new Option({ short: '-s' }),
      new Option({ short: '-M' }),
    ],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  uniq: new CommandSpec({
    options: [
      new Option({ short: '-c' }),
      new Option({ short: '-d' }),
      new Option({ short: '-u' }),
      new Option({ short: '-f', valueKind: OperandKind.TEXT }),
      new Option({ short: '-s', valueKind: OperandKind.TEXT }),
      new Option({ short: '-i' }),
      new Option({ short: '-w', valueKind: OperandKind.TEXT }),
    ],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  cut: new CommandSpec({
    options: [
      new Option({ short: '-f', valueKind: OperandKind.TEXT }),
      new Option({ short: '-d', valueKind: OperandKind.TEXT }),
      new Option({ short: '-c', valueKind: OperandKind.TEXT }),
      new Option({ long: '--complement' }),
      new Option({ short: '-z' }),
    ],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  mkdir: new CommandSpec({
    options: [new Option({ short: '-p' }), new Option({ short: '-v' })],
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
  cp: new CommandSpec({
    options: [
      new Option({ short: '-r' }),
      new Option({ short: '-R' }),
      new Option({ short: '-a' }),
      new Option({ short: '-f' }),
      new Option({ short: '-n' }),
      new Option({ short: '-v' }),
    ],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  mv: new CommandSpec({
    options: [
      new Option({ short: '-f' }),
      new Option({ short: '-n' }),
      new Option({ short: '-v' }),
    ],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  rm: new CommandSpec({
    options: [
      new Option({ short: '-r' }),
      new Option({ short: '-R' }),
      new Option({ short: '-f' }),
      new Option({ short: '-v' }),
      new Option({ short: '-d' }),
    ],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  sed: new CommandSpec({
    options: [
      new Option({ short: '-i' }),
      new Option({ short: '-e' }),
      new Option({ short: '-n' }),
      new Option({ short: '-E' }),
    ],
    positional: [new Operand({ kind: OperandKind.TEXT })],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  echo: new CommandSpec({
    options: [new Option({ short: '-n' }), new Option({ short: '-e' })],
    rest: new Operand({ kind: OperandKind.TEXT }),
  }),
  tee: new CommandSpec({
    options: [new Option({ short: '-a' })],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  tr: new CommandSpec({
    options: [
      new Option({ short: '-d' }),
      new Option({ short: '-s' }),
      new Option({ short: '-c' }),
    ],
    positional: [new Operand({ kind: OperandKind.TEXT }), new Operand({ kind: OperandKind.TEXT })],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  curl: new CommandSpec({
    description: 'Transfer data from or to a server.',
    options: [
      new Option({
        short: '-H',
        valueKind: OperandKind.TEXT,
        description: 'Add a custom header to the request.',
      }),
      new Option({
        short: '-A',
        valueKind: OperandKind.TEXT,
        description: 'Set the User-Agent header.',
      }),
      new Option({
        short: '-X',
        valueKind: OperandKind.TEXT,
        description: 'Specify the HTTP request method.',
      }),
      new Option({
        short: '-d',
        valueKind: OperandKind.TEXT,
        description: 'Send the given data as the request body.',
      }),
      new Option({
        short: '-F',
        valueKind: OperandKind.TEXT,
        description: 'Submit a multipart/form-data field.',
      }),
      new Option({
        short: '-o',
        valueKind: OperandKind.PATH,
        description: 'Write response body to the given file.',
      }),
      new Option({ short: '-L', description: 'Follow HTTP redirects.' }),
      new Option({ short: '-s', description: 'Run silently with no progress or messages.' }),
      new Option({ short: '-S', description: 'Show errors even when silent.' }),
      new Option({ long: '--jina', description: 'Fetch via the Jina Reader proxy.' }),
    ],
    rest: new Operand({ kind: OperandKind.TEXT }),
  }),
  wget: new CommandSpec({
    description: 'Retrieve files from the web.',
    options: [
      new Option({
        short: '-O',
        valueKind: OperandKind.PATH,
        description: 'Write the downloaded content to the given file.',
      }),
      new Option({ short: '-q', description: 'Run quietly with no output.' }),
      new Option({
        long: '--spider',
        description: 'Check that the URL exists without downloading it.',
      }),
    ],
    positional: [new Operand({ kind: OperandKind.TEXT })],
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
  awk: new CommandSpec({
    options: [
      new Option({ short: '-F', valueKind: OperandKind.TEXT }),
      new Option({ short: '-v', valueKind: OperandKind.TEXT }),
      new Option({ short: '-f', valueKind: OperandKind.PATH }),
    ],
    positional: [new Operand({ kind: OperandKind.TEXT })],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  paste: new CommandSpec({
    options: [
      new Option({ short: '-d', valueKind: OperandKind.TEXT }),
      new Option({ short: '-s' }),
    ],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  tac: new CommandSpec({ rest: new Operand({ kind: OperandKind.PATH }) }),
  printf: new CommandSpec({
    positional: [new Operand({ kind: OperandKind.TEXT })],
    rest: new Operand({ kind: OperandKind.TEXT }),
  }),
  seq: new CommandSpec({
    description: 'Print a sequence of numbers.',
    options: [
      new Option({
        short: '-s',
        valueKind: OperandKind.TEXT,
        description: 'Use the given separator between numbers.',
      }),
      new Option({
        short: '-w',
        valueKind: OperandKind.TEXT,
        description: 'Pad numbers with zeros to equal width.',
      }),
      new Option({
        short: '-f',
        valueKind: OperandKind.TEXT,
        description: 'Format each number with a printf-style format string.',
      }),
    ],
    rest: new Operand({ kind: OperandKind.TEXT }),
  }),
  base64: new CommandSpec({
    options: [
      new Option({ short: '-d' }),
      new Option({ short: '-D' }),
      new Option({ short: '-w', valueKind: OperandKind.TEXT }),
    ],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  sha256sum: new CommandSpec({
    options: [new Option({ short: '-c' })],
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
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  tar: new CommandSpec({
    options: [
      new Option({ short: '-c' }),
      new Option({ short: '-x' }),
      new Option({ short: '-t' }),
      new Option({ short: '-z' }),
      new Option({ short: '-j' }),
      new Option({ short: '-J' }),
      new Option({ short: '-v' }),
      new Option({ short: '-f', valueKind: OperandKind.PATH }),
      new Option({ short: '-C', valueKind: OperandKind.PATH }),
      new Option({ long: '--strip-components', valueKind: OperandKind.TEXT }),
      new Option({ long: '--exclude', valueKind: OperandKind.TEXT }),
    ],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  gzip: new CommandSpec({
    options: [
      new Option({ short: '-d' }),
      new Option({ short: '-k' }),
      new Option({ short: '-f' }),
      new Option({ short: '-c' }),
      new Option({ short: '-1' }),
      new Option({ short: '-2' }),
      new Option({ short: '-3' }),
      new Option({ short: '-4' }),
      new Option({ short: '-5' }),
      new Option({ short: '-6' }),
      new Option({ short: '-7' }),
      new Option({ short: '-8' }),
      new Option({ short: '-9' }),
    ],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  gunzip: new CommandSpec({
    options: [
      new Option({ short: '-k' }),
      new Option({ short: '-f' }),
      new Option({ short: '-c' }),
      new Option({ short: '-t' }),
    ],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  zip: new CommandSpec({
    options: [
      new Option({ short: '-r' }),
      new Option({ short: '-j' }),
      new Option({ short: '-q' }),
    ],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  unzip: new CommandSpec({
    options: [
      new Option({ short: '-o' }),
      new Option({ short: '-l' }),
      new Option({ short: '-d', valueKind: OperandKind.PATH }),
      new Option({ short: '-q' }),
      new Option({ short: '-p' }),
      new Option({ short: '-t' }),
    ],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  basename: new CommandSpec({ rest: new Operand({ kind: OperandKind.TEXT }) }),
  dirname: new CommandSpec({ rest: new Operand({ kind: OperandKind.TEXT }) }),
  realpath: new CommandSpec({
    options: [new Option({ short: '-e' }), new Option({ short: '-m' })],
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
  ln: new CommandSpec({
    options: [
      new Option({ short: '-s' }),
      new Option({ short: '-f' }),
      new Option({ short: '-n' }),
      new Option({ short: '-v' }),
    ],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  split: new CommandSpec({
    options: [
      new Option({ short: '-l', valueKind: OperandKind.TEXT }),
      new Option({ short: '-b', valueKind: OperandKind.TEXT }),
      new Option({ short: '-n', valueKind: OperandKind.TEXT }),
      new Option({ short: '-d' }),
      new Option({ short: '-a', valueKind: OperandKind.TEXT }),
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
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  shuf: new CommandSpec({
    options: [
      new Option({ short: '-n', valueKind: OperandKind.TEXT }),
      new Option({ short: '-e' }),
      new Option({ short: '-z' }),
      new Option({ short: '-r' }),
    ],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  comm: new CommandSpec({
    options: [
      new Option({ short: '-1' }),
      new Option({ short: '-2' }),
      new Option({ short: '-3' }),
      new Option({ long: '--check-order' }),
      new Option({ long: '--nocheck-order' }),
    ],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  column: new CommandSpec({
    options: [
      new Option({ short: '-t' }),
      new Option({ short: '-s', valueKind: OperandKind.TEXT }),
      new Option({ short: '-o', valueKind: OperandKind.TEXT }),
    ],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  fold: new CommandSpec({
    options: [
      new Option({ short: '-w', valueKind: OperandKind.TEXT }),
      new Option({ short: '-s' }),
    ],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  fmt: new CommandSpec({
    options: [new Option({ short: '-w', valueKind: OperandKind.TEXT })],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  cmp: new CommandSpec({
    options: [
      new Option({ short: '-l' }),
      new Option({ short: '-s' }),
      new Option({ short: '-n', valueKind: OperandKind.TEXT }),
      new Option({ short: '-b' }),
      new Option({ short: '-i', valueKind: OperandKind.TEXT }),
    ],
    rest: new Operand({ kind: OperandKind.PATH }),
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
  strings: new CommandSpec({
    options: [new Option({ short: '-n', valueKind: OperandKind.TEXT })],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  rev: new CommandSpec({ rest: new Operand({ kind: OperandKind.PATH }) }),
  zcat: new CommandSpec({ rest: new Operand({ kind: OperandKind.PATH }) }),
  zgrep: new CommandSpec({
    options: [
      new Option({ short: '-i' }),
      new Option({ short: '-c' }),
      new Option({ short: '-l' }),
      new Option({ short: '-n' }),
      new Option({ short: '-v' }),
      new Option({ short: '-e', valueKind: OperandKind.TEXT }),
      new Option({ short: '-E' }),
      new Option({ short: '-F' }),
      new Option({ short: '-H' }),
      new Option({ short: '-h' }),
      new Option({ short: '-m', valueKind: OperandKind.TEXT }),
      new Option({ short: '-o' }),
      new Option({ short: '-q' }),
      new Option({ short: '-w' }),
    ],
    positional: [new Operand({ kind: OperandKind.TEXT })],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  mktemp: new CommandSpec({
    options: [
      new Option({ short: '-d' }),
      new Option({ short: '-p', valueKind: OperandKind.TEXT }),
      new Option({ short: '-t' }),
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
  expr: new CommandSpec({
    description: 'Evaluate expressions.',
    rest: new Operand({ kind: OperandKind.TEXT }),
  }),
  history: new CommandSpec({
    description: 'Show command history for the session.',
    options: [new Option({ short: '-c', description: 'Clear the command history.' })],
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
    rest: new Operand({ kind: OperandKind.TEXT }),
  }),
  csplit: new CommandSpec({
    options: [
      new Option({ short: '-f', valueKind: OperandKind.TEXT }),
      new Option({ short: '-n', valueKind: OperandKind.TEXT }),
      new Option({ short: '-b', valueKind: OperandKind.TEXT }),
      new Option({ short: '-k' }),
      new Option({ short: '-s' }),
    ],
    positional: [new Operand({ kind: OperandKind.PATH })],
    rest: new Operand({ kind: OperandKind.TEXT }),
  }),
  expand: new CommandSpec({
    options: [
      new Option({ short: '-t', valueKind: OperandKind.TEXT }),
      new Option({ short: '-i' }),
    ],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  unexpand: new CommandSpec({
    options: [
      new Option({ short: '-t', valueKind: OperandKind.TEXT }),
      new Option({ short: '-a' }),
    ],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  tsort: new CommandSpec({ rest: new Operand({ kind: OperandKind.PATH }) }),
  look: new CommandSpec({
    options: [new Option({ short: '-f' })],
    positional: [new Operand({ kind: OperandKind.TEXT })],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
  sleep: new CommandSpec({
    description: 'Delay for a specified amount of time.',
    rest: new Operand({ kind: OperandKind.TEXT }),
  }),
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
  join: new CommandSpec({
    options: [
      new Option({ short: '-t', valueKind: OperandKind.TEXT }),
      new Option({ short: '-1', valueKind: OperandKind.TEXT }),
      new Option({ short: '-2', valueKind: OperandKind.TEXT }),
      new Option({ short: '-a', valueKind: OperandKind.TEXT }),
      new Option({ short: '-v', valueKind: OperandKind.TEXT }),
      new Option({ short: '-e', valueKind: OperandKind.TEXT }),
      new Option({ short: '-o', valueKind: OperandKind.TEXT }),
    ],
    rest: new Operand({ kind: OperandKind.PATH }),
  }),
})
