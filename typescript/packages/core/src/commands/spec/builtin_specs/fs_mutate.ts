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
  basename: new CommandSpec({
    arguments: [
      new Argument(['-a', '--multiple'], { action: 'store_true' }),
      new Argument(['-s', '--suffix']),
      new Argument(['-z', '--zero'], { action: 'store_true' }),
      new Argument('texts', { metavar: '', nargs: '*' }),
    ],
  }),
  chgrp: new CommandSpec({
    arguments: [
      new Argument(['-c', '--changes'], { action: 'store_true' }),
      new Argument(['-f', '--silent'], { action: 'store_true' }),
      new Argument('--quiet', { action: 'store_true' }),
      new Argument(['-v', '--verbose'], { action: 'store_true' }),
      new Argument('--dereference', { action: 'store_true' }),
      new Argument(['-h', '--no-dereference'], { action: 'store_true' }),
      new Argument(['-R', '--recursive'], { action: 'store_true' }),
      new Argument('text', { metavar: '', nargs: '?' }),
      new Argument('paths', { metavar: '', type: 'path', nargs: '*' }),
    ],
  }),
  chmod: new CommandSpec({
    arguments: [
      new Argument(['-c', '--changes'], { action: 'store_true' }),
      new Argument(['-f', '--silent'], { action: 'store_true' }),
      new Argument('--quiet', { action: 'store_true' }),
      new Argument(['-v', '--verbose'], { action: 'store_true' }),
      new Argument(['-R', '--recursive'], { action: 'store_true' }),
      new Argument('text', { metavar: '', nargs: '?' }),
      new Argument('paths', { metavar: '', type: 'path', nargs: '*' }),
    ],
  }),
  chown: new CommandSpec({
    arguments: [
      new Argument(['-c', '--changes'], { action: 'store_true' }),
      new Argument(['-f', '--silent'], { action: 'store_true' }),
      new Argument('--quiet', { action: 'store_true' }),
      new Argument(['-v', '--verbose'], { action: 'store_true' }),
      new Argument('--dereference', { action: 'store_true' }),
      new Argument(['-h', '--no-dereference'], { action: 'store_true' }),
      new Argument(['-R', '--recursive'], { action: 'store_true' }),
      new Argument('text', { metavar: '', nargs: '?' }),
      new Argument('paths', { metavar: '', type: 'path', nargs: '*' }),
    ],
  }),
  cp: new CommandSpec({
    arguments: [
      new Argument('-r', { action: 'store_true' }),
      new Argument(['-R', '--recursive'], { action: 'store_true' }),
      new Argument(['-a', '--archive'], { action: 'store_true' }),
      new Argument(['-L', '--dereference'], { action: 'store_true' }),
      new Argument(['-P', '--no-dereference'], { action: 'store_true' }),
      new Argument('-H', { action: 'store_true' }),
      new Argument('-d', { action: 'store_true' }),
      new Argument(['-f', '--force'], { action: 'store_true' }),
      new Argument(['-i', '--interactive'], { action: 'store_true' }),
      new Argument(['-n', '--no-clobber'], { action: 'store_true' }),
      new Argument(['-v', '--verbose'], { action: 'store_true' }),
      new Argument(['-u', '--update'], { nargs: '?', attachedOnly: true, shortValue: false }),
      new Argument(['-b', '--backup'], { nargs: '?', attachedOnly: true, shortValue: false }),
      new Argument('--strip-trailing-slashes', { action: 'store_true' }),
      new Argument(['-t', '--target-directory'], { type: 'path' }),
      new Argument(['-T', '--no-target-directory'], { action: 'store_true' }),
      new Argument(['-S', '--suffix']),
      new Argument(['-x', '--one-file-system'], { action: 'store_true' }),
      new Argument('paths', { metavar: '', type: 'path', nargs: '*' }),
    ],
  }),
  dirname: new CommandSpec({
    arguments: [
      new Argument(['-z', '--zero'], { action: 'store_true' }),
      new Argument('texts', { metavar: '', nargs: '*' }),
    ],
  }),
  // getfattr and setfattr run in the executor over the dispatcher's attribute
  // ops, like readlink and ln, so these specs are their grammar and no
  // builder binds them. Pinned against Debian's attr 2.5.2;
  // --one-file-system, --restore and --raw are not offered.
  getfattr: new CommandSpec({
    arguments: [
      new Argument(['-n', '--name'], { help: 'get the named extended attribute value' }),
      new Argument(['-d', '--dump'], {
        action: 'store_true',
        help: 'get all extended attribute values',
      }),
      new Argument(['-e', '--encoding'], { help: "encode values (as 'text', 'hex' or 'base64')" }),
      new Argument(['-m', '--match'], { help: 'only get attributes with names matching pattern' }),
      new Argument('--only-values', { action: 'store_true', help: 'print the bare values only' }),
      new Argument(['-h', '--no-dereference'], {
        action: 'store_true',
        help: 'do not dereference symbolic links',
      }),
      new Argument('--absolute-names', {
        action: 'store_true',
        help: "don't strip leading '/' in pathnames",
      }),
      new Argument(['-R', '--recursive'], {
        action: 'store_true',
        help: 'recurse into subdirectories',
      }),
      new Argument(['-L', '--logical'], {
        action: 'store_true',
        help: 'logical walk, follow symbolic links',
      }),
      new Argument(['-P', '--physical'], {
        action: 'store_true',
        help: 'physical walk, do not follow symbolic links',
      }),
      new Argument('paths', { metavar: '', type: 'path', nargs: '*' }),
    ],
  }),
  // ln runs in the executor for both link kinds (a symlink is namespace
  // state, a "hard link" is a byte copy through the dispatcher), so this spec
  // is its grammar authority and no builder binds it.
  ln: new CommandSpec({
    arguments: [
      new Argument(['-S', '--suffix']),
      new Argument(['-f', '--force'], { action: 'store_true' }),
      new Argument(['-n', '--no-dereference'], { action: 'store_true' }),
      new Argument(['-v', '--verbose'], { action: 'store_true' }),
      new Argument(['-r', '--relative'], { action: 'store_true' }),
      new Argument(['-L', '--logical'], { action: 'store_true' }),
      new Argument(['-P', '--physical'], { action: 'store_true' }),
      new Argument(['-d', '--directory'], { action: 'store_true' }),
      new Argument('-F', { action: 'store_true' }),
      new Argument(['-b', '--backup'], { nargs: '?', attachedOnly: true, shortValue: false }),
      new Argument(['-s', '--symbolic'], { action: 'store_true' }),
      new Argument(['-t', '--target-directory'], { type: 'path' }),
      new Argument(['-T', '--no-target-directory'], { action: 'store_true' }),
      new Argument('paths', { metavar: '', type: 'path', nargs: '*' }),
    ],
  }),
  mkdir: new CommandSpec({
    arguments: [
      new Argument(['-p', '--parents'], { action: 'store_true' }),
      new Argument(['-v', '--verbose'], { action: 'store_true' }),
      new Argument(['-m', '--mode']),
      new Argument(['-Z', '--context'], { nargs: '?', attachedOnly: true, shortValue: false }),
      new Argument('paths', { metavar: '', type: 'path', nargs: '*' }),
    ],
  }),
  mv: new CommandSpec({
    arguments: [
      new Argument(['-f', '--force'], { action: 'store_true' }),
      new Argument(['-i', '--interactive'], { action: 'store_true' }),
      new Argument(['-n', '--no-clobber'], { action: 'store_true' }),
      new Argument(['-v', '--verbose'], { action: 'store_true' }),
      new Argument(['-u', '--update'], { nargs: '?', attachedOnly: true, shortValue: false }),
      new Argument(['-b', '--backup'], { nargs: '?', attachedOnly: true, shortValue: false }),
      new Argument('--strip-trailing-slashes', { action: 'store_true' }),
      new Argument(['-t', '--target-directory'], { type: 'path' }),
      new Argument('--no-copy', { action: 'store_true' }),
      new Argument('--exchange', { action: 'store_true' }),
      new Argument(['-T', '--no-target-directory'], { action: 'store_true' }),
      new Argument(['-S', '--suffix']),
      new Argument('paths', { metavar: '', type: 'path', nargs: '*' }),
    ],
  }),
  readlink: new CommandSpec({
    arguments: [
      new Argument(['-f', '--canonicalize'], { action: 'store_true' }),
      new Argument(['-e', '--canonicalize-existing'], { action: 'store_true' }),
      new Argument(['-m', '--canonicalize-missing'], { action: 'store_true' }),
      new Argument(['-n', '--no-newline'], { action: 'store_true' }),
      new Argument(['-q', '--quiet'], { action: 'store_true' }),
      new Argument(['-s', '--silent'], { action: 'store_true' }),
      new Argument(['-v', '--verbose'], { action: 'store_true' }),
      new Argument(['-z', '--zero'], { action: 'store_true' }),
      new Argument('paths', { metavar: '', type: 'path', nargs: '*' }),
    ],
  }),
  realpath: new CommandSpec({
    arguments: [
      new Argument(['-e', '--canonicalize-existing'], { action: 'store_true' }),
      new Argument(['-m', '--canonicalize-missing'], { action: 'store_true' }),
      new Argument(['-L', '--logical'], { action: 'store_true' }),
      new Argument(['-P', '--physical'], { action: 'store_true' }),
      new Argument(['-q', '--quiet'], { action: 'store_true' }),
      new Argument('--relative-to'),
      new Argument('--relative-base'),
      new Argument(['-s', '--strip'], { action: 'store_true' }),
      new Argument('--no-symlinks', { action: 'store_true' }),
      new Argument(['-z', '--zero'], { action: 'store_true' }),
      new Argument('paths', { metavar: '', type: 'path', nargs: '*' }),
    ],
  }),
  rm: new CommandSpec({
    arguments: [
      new Argument('-r', { action: 'store_true' }),
      new Argument('-R', { action: 'store_true' }),
      new Argument('-f', { action: 'store_true' }),
      new Argument('-v', { action: 'store_true' }),
      new Argument('-d', { action: 'store_true' }),
      new Argument('-i', { action: 'store_true' }),
      new Argument('-I', { action: 'store_true' }),
      new Argument('--preserve-root', { action: 'store_true' }),
      new Argument('--no-preserve-root', { action: 'store_true' }),
      new Argument('--one-file-system', { action: 'store_true' }),
      new Argument('paths', { metavar: '', type: 'path', nargs: '*' }),
    ],
  }),
  rmdir: new CommandSpec({
    arguments: [
      new Argument('--ignore-fail-on-non-empty', { action: 'store_true' }),
      new Argument(['-p', '--parents'], { action: 'store_true' }),
      new Argument(['-v', '--verbose'], { action: 'store_true' }),
      new Argument('paths', { metavar: '', type: 'path', nargs: '*' }),
    ],
  }),
  setfattr: new CommandSpec({
    arguments: [
      new Argument(['-n', '--name'], { help: 'set the value of the named extended attribute' }),
      new Argument(['-x', '--remove'], { help: 'remove the named extended attribute' }),
      new Argument(['-v', '--value'], { help: 'use value as the attribute value' }),
      new Argument(['-h', '--no-dereference'], {
        action: 'store_true',
        help: 'do not dereference symbolic links',
      }),
      new Argument('paths', { metavar: '', type: 'path', nargs: '*' }),
    ],
  }),
  touch: new CommandSpec({
    arguments: [
      new Argument('-a', { action: 'store_true' }),
      new Argument(['-c', '--no-create'], { action: 'store_true' }),
      new Argument(['-d', '--date']),
      new Argument('-f', { action: 'store_true' }),
      new Argument(['-h', '--no-dereference'], { action: 'store_true' }),
      new Argument('-m', { action: 'store_true' }),
      new Argument(['-r', '--reference'], { type: 'path' }),
      new Argument('-t'),
      new Argument('--time'),
      new Argument('paths', { metavar: '', type: 'path', nargs: '*' }),
    ],
  }),
  truncate: new CommandSpec({
    arguments: [
      new Argument(['-c', '--no-create'], { action: 'store_true' }),
      new Argument(['-s', '--size']),
      new Argument('paths', { metavar: '', type: 'path', nargs: '*' }),
    ],
  }),
  unlink: new CommandSpec({
    arguments: [new Argument('paths', { metavar: '', type: 'path', nargs: '*' })],
  }),
}
