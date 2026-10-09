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
  basename: new CommandSpec({
    options: [
      new Option({ short: '-a', long: '--multiple' }),
      new Option({ short: '-s', long: '--suffix', type: 'str' }),
      new Option({ short: '-z', long: '--zero' }),
    ],
    rest: new Operand({ type: 'str' }),
  }),
  chgrp: new CommandSpec({
    options: [
      new Option({ short: '-c', long: '--changes' }),
      new Option({ short: '-f', long: '--silent' }),
      new Option({ long: '--quiet' }),
      new Option({ short: '-v', long: '--verbose' }),
      new Option({ long: '--dereference' }),
      new Option({ short: '-h', long: '--no-dereference' }),
      new Option({ short: '-R', long: '--recursive' }),
    ],
    positional: [new Operand({ type: 'str' })],
    rest: new Operand({ type: 'path' }),
  }),
  chmod: new CommandSpec({
    options: [
      new Option({ short: '-c', long: '--changes' }),
      new Option({ short: '-f', long: '--silent' }),
      new Option({ long: '--quiet' }),
      new Option({ short: '-v', long: '--verbose' }),
      new Option({ short: '-R', long: '--recursive' }),
    ],
    positional: [new Operand({ type: 'str' })],
    rest: new Operand({ type: 'path' }),
  }),
  chown: new CommandSpec({
    options: [
      new Option({ short: '-c', long: '--changes' }),
      new Option({ short: '-f', long: '--silent' }),
      new Option({ long: '--quiet' }),
      new Option({ short: '-v', long: '--verbose' }),
      new Option({ long: '--dereference' }),
      new Option({ short: '-h', long: '--no-dereference' }),
      new Option({ short: '-R', long: '--recursive' }),
    ],
    positional: [new Operand({ type: 'str' })],
    rest: new Operand({ type: 'path' }),
  }),
  cp: new CommandSpec({
    options: [
      new Option({ short: '-r' }),
      new Option({ short: '-R', long: '--recursive' }),
      new Option({ short: '-a', long: '--archive' }),
      // The link policy: the last of these and -a wins.
      new Option({ short: '-L', long: '--dereference' }),
      new Option({ short: '-P', long: '--no-dereference' }),
      new Option({ short: '-H' }),
      new Option({ short: '-d' }),
      // Non-interactive control plane (rm precedent): -f/-i are accepted
      // no-ops — there is no prompt, and an overwrite proceeds unless
      // -n/--update say otherwise.
      new Option({ short: '-f', long: '--force' }),
      new Option({ short: '-i', long: '--interactive' }),
      new Option({ short: '-n', long: '--no-clobber' }),
      new Option({ short: '-v', long: '--verbose' }),
      // GNU: -u/-b never take an argument; only --update=/--backup=
      // carry values, so the shorts stay clusterable (-bv).
      new Option({
        short: '-u',
        long: '--update',
        type: 'str',
        valueOptional: true,
        shortValue: false,
      }),
      new Option({
        short: '-b',
        long: '--backup',
        type: 'str',
        valueOptional: true,
        shortValue: false,
      }),
      // PathSpec normalizes trailing slashes everywhere, so the GNU
      // spelling is an accepted no-op.
      new Option({ long: '--strip-trailing-slashes' }),
      new Option({ short: '-t', long: '--target-directory', type: 'path' }),
      new Option({ short: '-T', long: '--no-target-directory' }),
      new Option({ short: '-S', long: '--suffix', type: 'str' }),
      new Option({ short: '-x', long: '--one-file-system' }),
    ],
    rest: new Operand({ type: 'path' }),
  }),
  dirname: new CommandSpec({
    options: [new Option({ short: '-z', long: '--zero' })],
    rest: new Operand({ type: 'str' }),
  }),
  // getfattr and setfattr run in the executor over the dispatcher's attribute
  // ops, like readlink and ln, so these specs are their grammar and no
  // builder binds them. Pinned against Debian's attr 2.5.2;
  // --one-file-system, --restore and --raw are not offered.
  getfattr: new CommandSpec({
    options: [
      new Option({
        short: '-n',
        long: '--name',
        type: 'str',
        description: 'get the named extended attribute value',
      }),
      new Option({ short: '-d', long: '--dump', description: 'get all extended attribute values' }),
      new Option({
        short: '-e',
        long: '--encoding',
        type: 'str',
        description: "encode values (as 'text', 'hex' or 'base64')",
      }),
      new Option({
        short: '-m',
        long: '--match',
        type: 'str',
        description: 'only get attributes with names matching pattern',
      }),
      new Option({ long: '--only-values', description: 'print the bare values only' }),
      new Option({
        short: '-h',
        long: '--no-dereference',
        description: 'do not dereference symbolic links',
      }),
      new Option({
        long: '--absolute-names',
        description: "don't strip leading '/' in pathnames",
      }),
      new Option({ short: '-R', long: '--recursive', description: 'recurse into subdirectories' }),
      new Option({
        short: '-L',
        long: '--logical',
        description: 'logical walk, follow symbolic links',
      }),
      new Option({
        short: '-P',
        long: '--physical',
        description: 'physical walk, do not follow symbolic links',
      }),
    ],
    rest: new Operand({ type: 'path' }),
  }),
  // ln runs in the executor for both link kinds (a symlink is namespace
  // state, a "hard link" is a byte copy through the dispatcher), so this spec
  // is its grammar authority and no builder binds it.
  ln: new CommandSpec({
    options: [
      new Option({ short: '-S', long: '--suffix', type: 'str' }),
      new Option({ short: '-f', long: '--force' }),
      new Option({ short: '-n', long: '--no-dereference' }),
      new Option({ short: '-v', long: '--verbose' }),
      new Option({ short: '-r', long: '--relative' }),
      new Option({ short: '-L', long: '--logical' }),
      new Option({ short: '-P', long: '--physical' }),
      new Option({ short: '-d', long: '--directory' }),
      new Option({ short: '-F' }),
      // GNU: -b never takes an argument; only --backup= carries a value,
      // so the short stays clusterable (-sbv).
      new Option({
        short: '-b',
        long: '--backup',
        type: 'str',
        valueOptional: true,
        shortValue: false,
      }),
      new Option({ short: '-s', long: '--symbolic' }),
      new Option({ short: '-t', long: '--target-directory', type: 'path' }),
      new Option({ short: '-T', long: '--no-target-directory' }),
    ],
    rest: new Operand({ type: 'path' }),
  }),
  mkdir: new CommandSpec({
    options: [
      new Option({ short: '-p', long: '--parents' }),
      new Option({ short: '-v', long: '--verbose' }),
      new Option({ short: '-m', long: '--mode', type: 'str' }),
      // GNU: -Z never takes an argument; only --context= carries one, so
      // the short stays clusterable (-vZ) and `-Zfoo` is refused.
      new Option({
        short: '-Z',
        long: '--context',
        type: 'str',
        valueOptional: true,
        shortValue: false,
      }),
    ],
    rest: new Operand({ type: 'path' }),
  }),
  mv: new CommandSpec({
    options: [
      // Non-interactive control plane (rm precedent): -f/-i are accepted
      // no-ops — there is no prompt, and an overwrite proceeds unless
      // -n/--update say otherwise.
      new Option({ short: '-f', long: '--force' }),
      new Option({ short: '-i', long: '--interactive' }),
      new Option({ short: '-n', long: '--no-clobber' }),
      new Option({ short: '-v', long: '--verbose' }),
      // GNU: -u/-b never take an argument; only --update=/--backup=
      // carry values, so the shorts stay clusterable (-bv).
      new Option({
        short: '-u',
        long: '--update',
        type: 'str',
        valueOptional: true,
        shortValue: false,
      }),
      new Option({
        short: '-b',
        long: '--backup',
        type: 'str',
        valueOptional: true,
        shortValue: false,
      }),
      // PathSpec normalizes trailing slashes everywhere, so the GNU
      // spelling is an accepted no-op.
      new Option({ long: '--strip-trailing-slashes' }),
      new Option({ short: '-t', long: '--target-directory', type: 'path' }),
      // Cross-mount moves are copy+remove; --no-copy turns them into
      // GNU's cross-device refusal instead.
      new Option({ long: '--no-copy' }),
      new Option({ long: '--exchange' }),
      new Option({ short: '-T', long: '--no-target-directory' }),
      new Option({ short: '-S', long: '--suffix', type: 'str' }),
    ],
    rest: new Operand({ type: 'path' }),
  }),
  readlink: new CommandSpec({
    options: [
      new Option({ short: '-f', long: '--canonicalize' }),
      new Option({ short: '-e', long: '--canonicalize-existing' }),
      new Option({ short: '-m', long: '--canonicalize-missing' }),
      new Option({ short: '-n', long: '--no-newline' }),
      new Option({ short: '-q', long: '--quiet' }),
      new Option({ short: '-s', long: '--silent' }),
      new Option({ short: '-v', long: '--verbose' }),
      new Option({ short: '-z', long: '--zero' }),
    ],
    rest: new Operand({ type: 'path' }),
  }),
  realpath: new CommandSpec({
    options: [
      new Option({ short: '-e', long: '--canonicalize-existing' }),
      new Option({ short: '-m', long: '--canonicalize-missing' }),
      new Option({ short: '-L', long: '--logical' }),
      new Option({ short: '-P', long: '--physical' }),
      new Option({ short: '-q', long: '--quiet' }),
      new Option({ long: '--relative-to', type: 'str' }),
      new Option({ long: '--relative-base', type: 'str' }),
      new Option({ short: '-s', long: '--strip' }),
      new Option({ long: '--no-symlinks' }),
      new Option({ short: '-z', long: '--zero' }),
    ],
    rest: new Operand({ type: 'path' }),
  }),
  rm: new CommandSpec({
    options: [
      new Option({ short: '-r' }),
      new Option({ short: '-R' }),
      new Option({ short: '-f' }),
      new Option({ short: '-v' }),
      new Option({ short: '-d' }),
      // Non-interactive control plane: -i/-I are accepted no-ops (there is
      // no prompt; removal always proceeds).
      new Option({ short: '-i' }),
      new Option({ short: '-I' }),
      // Mount roots (and /) are structurally protected and never removable,
      // so the root failsafe is always on and cannot be disabled; both
      // spellings are accepted no-ops. Recursion never crosses a mount
      // boundary either, so --one-file-system already matches the default.
      new Option({ long: '--preserve-root' }),
      new Option({ long: '--no-preserve-root' }),
      new Option({ long: '--one-file-system' }),
    ],
    rest: new Operand({ type: 'path' }),
  }),
  rmdir: new CommandSpec({
    options: [
      new Option({ long: '--ignore-fail-on-non-empty' }),
      new Option({ short: '-p', long: '--parents' }),
      new Option({ short: '-v', long: '--verbose' }),
    ],
    rest: new Operand({ type: 'path' }),
  }),
  setfattr: new CommandSpec({
    options: [
      new Option({
        short: '-n',
        long: '--name',
        type: 'str',
        description: 'set the value of the named extended attribute',
      }),
      new Option({
        short: '-x',
        long: '--remove',
        type: 'str',
        description: 'remove the named extended attribute',
      }),
      new Option({
        short: '-v',
        long: '--value',
        type: 'str',
        description: 'use value as the attribute value',
      }),
      new Option({
        short: '-h',
        long: '--no-dereference',
        description: 'do not dereference symbolic links',
      }),
    ],
    rest: new Operand({ type: 'path' }),
  }),
  touch: new CommandSpec({
    options: [
      new Option({ short: '-a' }),
      new Option({ short: '-c', long: '--no-create' }),
      new Option({ short: '-d', long: '--date', type: 'str' }),
      new Option({ short: '-f' }),
      new Option({ short: '-h', long: '--no-dereference' }),
      new Option({ short: '-m' }),
      new Option({ short: '-r', long: '--reference', type: 'path' }),
      new Option({ short: '-t', type: 'str' }),
      new Option({ long: '--time', type: 'str' }),
    ],
    rest: new Operand({ type: 'path' }),
  }),
  truncate: new CommandSpec({
    options: [
      new Option({ short: '-c', long: '--no-create' }),
      new Option({ short: '-s', long: '--size', type: 'str' }),
    ],
    rest: new Operand({ type: 'path' }),
  }),
  unlink: new CommandSpec({ rest: new Operand({ type: 'path' }) }),
}
