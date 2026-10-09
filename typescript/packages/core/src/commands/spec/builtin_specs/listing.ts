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

export const SPECS: Record<string, CommandSpec> = {
  df: new CommandSpec({
    arguments: [
      new Argument('-h', { action: 'store_true' }),
      new Argument('-H', { action: 'store_true' }),
      new Argument('-k', { action: 'store_true' }),
      new Argument('-i', { action: 'store_true' }),
      new Argument('-a', { action: 'store_true' }),
      new Argument('-T', { action: 'store_true' }),
      new Argument('-P', { action: 'store_true' }),
      new Argument('-B'),
      new Argument('paths', { metavar: '', type: 'path', nargs: '*' }),
    ],
  }),
  du: new CommandSpec({
    arguments: [
      new Argument('-h', { action: 'store_true' }),
      new Argument('-s', { action: 'store_true' }),
      new Argument('-a', { action: 'store_true' }),
      new Argument(['-d', '--max-depth']),
      new Argument('-c', { action: 'store_true' }),
      new Argument('-L', { action: 'store_true' }),
      new Argument('-P', { action: 'store_true' }),
      new Argument(['-S', '--separate-dirs'], { action: 'store_true' }),
      new Argument(['-x', '--one-file-system'], { action: 'store_true' }),
      new Argument('paths', { metavar: '', type: 'path', nargs: '*' }),
    ],
  }),
  mount: new CommandSpec({
    description: 'Mount a filesystem.',
    arguments: [
      new Argument(['-a', '--all'], {
        action: 'store_true',
        help: 'Mount all filesystems mentioned in fstab.',
      }),
      new Argument(['-f', '--fake'], {
        action: 'store_true',
        help: 'Dry run; skip the mount(2) syscall.',
      }),
      new Argument(['-l', '--show-labels'], {
        action: 'store_true',
        help: 'Show also filesystem labels.',
      }),
      new Argument(['-n', '--no-mtab'], {
        action: 'store_true',
        help: "Don't write to /etc/mtab.",
      }),
      new Argument(['-o', '--options'], { help: 'Comma-separated list of mount options.' }),
      new Argument(['-r', '--read-only'], {
        action: 'store_true',
        help: 'Mount the filesystem read-only.',
      }),
      new Argument(['-t', '--types'], { help: 'Limit the set of filesystem types.' }),
      new Argument(['-v', '--verbose'], { action: 'store_true', help: 'Say what is being done.' }),
      new Argument(['-w', '--rw'], {
        action: 'store_true',
        help: 'Mount the filesystem read-write (default).',
      }),
      new Argument(['-B', '--bind'], {
        action: 'store_true',
        help: 'Mount a subtree somewhere else.',
      }),
      new Argument(['-M', '--move'], {
        action: 'store_true',
        help: 'Move a subtree to some other place.',
      }),
      new Argument(['-R', '--rbind'], {
        action: 'store_true',
        help: 'Mount a subtree and all submounts somewhere else.',
      }),
      new Argument('texts', { metavar: '', nargs: '*' }),
    ],
  }),
  file: new CommandSpec({
    arguments: [
      new Argument('-b', { action: 'store_true' }),
      new Argument('-i', { action: 'store_true' }),
      new Argument('-L', { action: 'store_true' }),
      new Argument('-h', { action: 'store_true' }),
      new Argument('paths', { metavar: '', type: 'path', nargs: '*' }),
    ],
  }),
  find: new CommandSpec({
    arguments: [
      new Argument('-name', { action: 'append' }),
      new Argument('-type', { action: 'append' }),
      new Argument('-maxdepth', { action: 'append' }),
      new Argument('-size', { action: 'append' }),
      new Argument('-mtime', { action: 'append' }),
      new Argument('-iname', { action: 'append' }),
      new Argument('-path', { action: 'append' }),
      new Argument('-mindepth', { action: 'append' }),
      new Argument('-printf', { action: 'append' }),
      new Argument('-newer', { action: 'append' }),
      new Argument('-newermt', { action: 'append' }),
      new Argument('-P', { action: 'store_true' }),
      new Argument('-H', { action: 'store_true' }),
      new Argument('-L', { action: 'store_true' }),
      new Argument('-print', { action: 'store_true' }),
      new Argument('-print0', { action: 'store_true' }),
      new Argument('-delete', { action: 'store_true' }),
      new Argument('-depth', { action: 'store_true' }),
      new Argument('-xdev', { action: 'store_true' }),
      new Argument('-mount', { action: 'store_true' }),
      new Argument('-prune', { action: 'store_true' }),
      new Argument('-ls', { action: 'store_true' }),
      new Argument('-empty', { action: 'store_true' }),
      new Argument('-o', { action: 'store_true' }),
      new Argument('-or', { action: 'store_true' }),
      new Argument('-a', { action: 'store_true' }),
      new Argument('-and', { action: 'store_true' }),
      new Argument('-not', { action: 'store_true' }),
      new Argument('paths', { metavar: '', type: 'path', nargs: '*' }),
    ],
    ignoreTokens: ['(', ')', '!'],
  }),
  ls: new CommandSpec({
    arguments: [
      new Argument('-l', { action: 'store_true' }),
      new Argument(['-b', '--escape'], { action: 'store_true' }),
      new Argument(['-a', '--all'], { action: 'store_true' }),
      new Argument(['-A', '--almost-all'], { action: 'store_true' }),
      new Argument(['-h', '--human-readable'], { action: 'store_true' }),
      new Argument('-t', { action: 'store_true' }),
      new Argument('-S', { action: 'store_true' }),
      new Argument('-X', { action: 'store_true' }),
      new Argument('-v', { action: 'store_true' }),
      new Argument('-U', { action: 'store_true' }),
      new Argument('--sort'),
      new Argument('-c', { action: 'store_true' }),
      new Argument('-u', { action: 'store_true' }),
      new Argument('--time'),
      new Argument('--time-style'),
      new Argument(['-r', '--reverse'], { action: 'store_true' }),
      new Argument('-1', { action: 'store_true' }),
      new Argument(['-R', '--recursive'], { action: 'store_true' }),
      new Argument(['-d', '--directory'], { action: 'store_true' }),
      new Argument(['-F', '--classify'], { nargs: '?', attachedOnly: true, shortValue: false }),
      new Argument('-p', { action: 'store_true' }),
      new Argument('--file-type', { action: 'store_true' }),
      new Argument('--indicator-style'),
      new Argument(['-L', '--dereference'], { action: 'store_true' }),
      new Argument(['-H', '--dereference-command-line'], { action: 'store_true' }),
      new Argument('--dereference-command-line-symlink-to-dir', { action: 'store_true' }),
      new Argument('-g', { action: 'store_true' }),
      new Argument('-o', { action: 'store_true' }),
      new Argument(['-n', '--numeric-uid-gid'], { action: 'store_true' }),
      new Argument(['-i', '--inode'], { action: 'store_true' }),
      new Argument('--color', { nargs: '?', attachedOnly: true }),
      new Argument('--group-directories-first', { action: 'store_true' }),
      new Argument('--block-size'),
      new Argument('--hyperlink', { nargs: '?', attachedOnly: true }),
      new Argument(['-Z', '--context'], { action: 'store_true' }),
      new Argument('paths', { metavar: '', type: 'path', nargs: '*' }),
    ],
  }),
  pwd: new CommandSpec({
    arguments: [
      new Argument('-P', { action: 'store_true' }),
      new Argument('-L', { action: 'store_true' }),
      new Argument('texts', { metavar: '', nargs: '*' }),
    ],
  }),
  stat: new CommandSpec({
    arguments: [
      new Argument(['-c', '--format']),
      new Argument(['-f', '--file-system'], { action: 'store_true' }),
      new Argument(['-L', '--dereference'], { action: 'store_true' }),
      new Argument('paths', { metavar: '', type: 'path', nargs: '*' }),
    ],
  }),
  tree: new CommandSpec({
    arguments: [
      new Argument('-a', { action: 'store_true' }),
      new Argument('-L'),
      new Argument('-I'),
      new Argument('-d', { action: 'store_true' }),
      new Argument('-P'),
      new Argument('-x', { action: 'store_true' }),
      new Argument('paths', { metavar: '', type: 'path', nargs: '*' }),
    ],
  }),
}
