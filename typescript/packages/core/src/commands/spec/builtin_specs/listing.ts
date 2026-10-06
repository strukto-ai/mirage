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
  df: new CommandSpec({
    options: [
      new Option({ short: '-h' }),
      new Option({ short: '-H' }),
      new Option({ short: '-k' }),
      new Option({ short: '-i' }),
      new Option({ short: '-a' }),
      new Option({ short: '-T' }),
      new Option({ short: '-P' }),
      new Option({ short: '-B', type: 'str' }),
    ],
    rest: new Operand({ type: 'path' }),
  }),
  du: new CommandSpec({
    options: [
      new Option({ short: '-h' }),
      new Option({ short: '-s' }),
      new Option({ short: '-a' }),
      new Option({ short: '-d', long: '--max-depth', type: 'str' }),
      new Option({ short: '-c' }),
      new Option({ short: '-L' }),
      new Option({ short: '-P' }),
      new Option({ short: '-S', long: '--separate-dirs' }),
      new Option({ short: '-x', long: '--one-file-system' }),
    ],
    rest: new Operand({ type: 'path' }),
  }),
  mount: new CommandSpec({
    description: 'Mount a filesystem.',
    options: [
      new Option({
        short: '-a',
        long: '--all',
        description: 'Mount all filesystems mentioned in fstab.',
      }),
      new Option({
        short: '-f',
        long: '--fake',
        description: 'Dry run; skip the mount(2) syscall.',
      }),
      new Option({
        short: '-l',
        long: '--show-labels',
        description: 'Show also filesystem labels.',
      }),
      new Option({ short: '-n', long: '--no-mtab', description: "Don't write to /etc/mtab." }),
      new Option({
        short: '-o',
        long: '--options',
        type: 'str',
        description: 'Comma-separated list of mount options.',
      }),
      new Option({
        short: '-r',
        long: '--read-only',
        description: 'Mount the filesystem read-only.',
      }),
      new Option({
        short: '-t',
        long: '--types',
        type: 'str',
        description: 'Limit the set of filesystem types.',
      }),
      new Option({ short: '-v', long: '--verbose', description: 'Say what is being done.' }),
      new Option({
        short: '-w',
        long: '--rw',
        description: 'Mount the filesystem read-write (default).',
      }),
      new Option({ short: '-B', long: '--bind', description: 'Mount a subtree somewhere else.' }),
      new Option({
        short: '-M',
        long: '--move',
        description: 'Move a subtree to some other place.',
      }),
      new Option({
        short: '-R',
        long: '--rbind',
        description: 'Mount a subtree and all submounts somewhere else.',
      }),
    ],
    rest: new Operand({ type: 'str' }),
  }),
  file: new CommandSpec({
    options: [
      new Option({ short: '-b' }),
      new Option({ short: '-i' }),
      new Option({ short: '-L' }),
      new Option({ short: '-h' }),
    ],
    rest: new Operand({ type: 'path' }),
  }),
  find: new CommandSpec({
    options: [
      new Option({ short: '-name', type: 'str', multiple: true }),
      new Option({ short: '-type', type: 'str', multiple: true }),
      new Option({ short: '-maxdepth', type: 'str', multiple: true }),
      new Option({ short: '-size', type: 'str', multiple: true }),
      new Option({ short: '-mtime', type: 'str', multiple: true }),
      new Option({ short: '-iname', type: 'str', multiple: true }),
      new Option({ short: '-path', type: 'str', multiple: true }),
      new Option({ short: '-mindepth', type: 'str', multiple: true }),
      new Option({ short: '-printf', type: 'str', multiple: true }),
      new Option({ short: '-newer', type: 'str', multiple: true }),
      new Option({ short: '-newermt', type: 'str', multiple: true }),
      // `-exec CMD ARGS... ;` is consumed by the expression parser, never
      // by this spec: the classifier keeps its words as text (`execSpans`),
      // and there is no argparse shape for an option whose argument is a
      // program.
      // GNU find's link policy: -P (no follow) is the default, -H
      // follows only the start point, -L follows everything.
      new Option({ short: '-P' }),
      new Option({ short: '-H' }),
      new Option({ short: '-L' }),
      new Option({ short: '-print' }),
      new Option({ short: '-print0' }),
      new Option({ short: '-delete' }),
      new Option({ short: '-depth' }),
      new Option({ short: '-xdev' }),
      new Option({ short: '-mount' }),
      new Option({ short: '-prune' }),
      new Option({ short: '-ls' }),
      new Option({ short: '-empty' }),
      new Option({ short: '-o' }),
      new Option({ short: '-or' }),
      new Option({ short: '-a' }),
      new Option({ short: '-and' }),
      new Option({ short: '-not' }),
    ],
    rest: new Operand({ type: 'path' }),
    // `!` is GNU's negation, spelled without a leading dash, so the rest
    // slot's PATH kind would read it as a start point. It joins the parens
    // here rather than becoming an Option: an option is matched by
    // spelling and `-not` already covers that half, while these three are
    // grammar the expression parser consumes.
    ignoreTokens: ['(', ')', '!'],
  }),
  ls: new CommandSpec({
    options: [
      new Option({ short: '-l' }),
      new Option({ short: '-b', long: '--escape' }),
      new Option({ short: '-a', long: '--all' }),
      new Option({ short: '-A', long: '--almost-all' }),
      new Option({ short: '-h', long: '--human-readable' }),
      new Option({ short: '-t' }),
      new Option({ short: '-S' }),
      new Option({ short: '-X' }),
      new Option({ short: '-v' }),
      new Option({ short: '-U' }),
      new Option({ long: '--sort', type: 'str' }),
      new Option({ short: '-c' }),
      new Option({ short: '-u' }),
      new Option({ long: '--time', type: 'str' }),
      new Option({ long: '--time-style', type: 'str' }),
      new Option({ short: '-r', long: '--reverse' }),
      new Option({ short: '-1' }),
      new Option({ short: '-R', long: '--recursive' }),
      new Option({ short: '-d', long: '--directory' }),
      // -F classifies outright; only the long form takes GNU's WHEN.
      new Option({
        short: '-F',
        long: '--classify',
        type: 'str',
        valueOptional: true,
        shortValue: false,
      }),
      new Option({ short: '-p' }),
      new Option({ long: '--file-type' }),
      new Option({ long: '--indicator-style', type: 'str' }),
      new Option({ short: '-L', long: '--dereference' }),
      new Option({ short: '-H', long: '--dereference-command-line' }),
      new Option({ long: '--dereference-command-line-symlink-to-dir' }),
      new Option({ short: '-g' }),
      new Option({ short: '-o' }),
      new Option({ short: '-n', long: '--numeric-uid-gid' }),
      new Option({ short: '-i', long: '--inode' }),
      // Accepted no-op like grep --color (#471).
      new Option({ long: '--color', type: 'str', valueOptional: true }),
      new Option({ long: '--group-directories-first' }),
      new Option({ long: '--block-size', type: 'str' }),
      new Option({ long: '--hyperlink', type: 'str', valueOptional: true }),
      new Option({ short: '-Z', long: '--context' }),
    ],
    rest: new Operand({ type: 'path' }),
  }),
  pwd: new CommandSpec({
    options: [new Option({ short: '-P' }), new Option({ short: '-L' })],
    rest: new Operand({ type: 'str' }),
  }),
  stat: new CommandSpec({
    options: [
      new Option({ short: '-c', long: '--format', type: 'str' }),
      new Option({ short: '-f', long: '--file-system' }),
      new Option({ short: '-L', long: '--dereference' }),
    ],
    rest: new Operand({ type: 'path' }),
  }),
  tree: new CommandSpec({
    options: [
      new Option({ short: '-a' }),
      new Option({ short: '-L', type: 'str' }),
      new Option({ short: '-I', type: 'str' }),
      new Option({ short: '-d' }),
      new Option({ short: '-P', type: 'str' }),
      new Option({ short: '-x' }),
    ],
    rest: new Operand({ type: 'path' }),
  }),
}
