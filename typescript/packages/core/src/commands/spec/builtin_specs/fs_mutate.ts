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
    rest: new Operand({ type: 'str' }) }),
  chgrp: new CommandSpec({
    options: [
      new Option({ short: '-R' }),
      new Option({ short: '-v' }),
      new Option({ short: '-f' }),
      new Option({ short: '-h' }),
    ],
    positional: [new Operand({ type: 'str' })],
    rest: new Operand({ type: 'path' }) }),
  chmod: new CommandSpec({
    options: [
      new Option({ short: '-R' }),
      new Option({ short: '-v' }),
      new Option({ short: '-f' }),
    ],
    positional: [new Operand({ type: 'str' })],
    rest: new Operand({ type: 'path' }) }),
  chown: new CommandSpec({
    options: [
      new Option({ short: '-R' }),
      new Option({ short: '-v' }),
      new Option({ short: '-f' }),
      new Option({ short: '-h' }),
    ],
    positional: [new Operand({ type: 'str' })],
    rest: new Operand({ type: 'path' }) }),
  cp: new CommandSpec({
    options: [
      new Option({ short: '-r' }),
      new Option({ short: '-R', long: '--recursive' }),
      new Option({ short: '-a', long: '--archive' }),
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
        shortValue: false }),
      new Option({
        short: '-b',
        long: '--backup',
        type: 'str',
        valueOptional: true,
        shortValue: false }),
      new Option({ short: '-S', long: '--suffix', type: 'str' }),
      new Option({ short: '-t', long: '--target-directory', type: 'path' }),
      new Option({ short: '-T', long: '--no-target-directory' }),
      // PathSpec normalizes trailing slashes everywhere, so the GNU
      // spelling is an accepted no-op.
      new Option({ long: '--strip-trailing-slashes' }),
    ],
    rest: new Operand({ type: 'path' }) }),
  dirname: new CommandSpec({
    options: [new Option({ short: '-z', long: '--zero' })],
    rest: new Operand({ type: 'str' }) }),
  ln: new CommandSpec({
    options: [
      new Option({ short: '-s' }),
      new Option({ short: '-f' }),
      new Option({ short: '-n' }),
      new Option({ short: '-v' }),
    ],
    rest: new Operand({ type: 'path' }) }),
  mkdir: new CommandSpec({
    options: [
      new Option({ short: '-p', long: '--parents' }),
      new Option({ short: '-v', long: '--verbose' }),
      new Option({ short: '-m', long: '--mode', type: 'str' }),
      new Option({
        short: '-Z',
        long: '--context',
        type: 'str',
        valueOptional: true }),
    ],
    rest: new Operand({ type: 'path' }) }),
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
        shortValue: false }),
      new Option({
        short: '-b',
        long: '--backup',
        type: 'str',
        valueOptional: true,
        shortValue: false }),
      new Option({ short: '-S', long: '--suffix', type: 'str' }),
      new Option({ short: '-t', long: '--target-directory', type: 'path' }),
      new Option({ short: '-T', long: '--no-target-directory' }),
      new Option({ long: '--exchange' }),
      // Cross-mount moves are copy+remove; --no-copy turns them into
      // GNU's cross-device refusal instead.
      new Option({ long: '--no-copy' }),
      // PathSpec normalizes trailing slashes everywhere, so the GNU
      // spelling is an accepted no-op.
      new Option({ long: '--strip-trailing-slashes' }),
    ],
    rest: new Operand({ type: 'path' }) }),
  readlink: new CommandSpec({
    options: [
      new Option({ short: '-f' }),
      new Option({ short: '-e' }),
      new Option({ short: '-m' }),
      new Option({ short: '-n' }),
    ],
    rest: new Operand({ type: 'path' }) }),
  realpath: new CommandSpec({
    options: [new Option({ short: '-e' }), new Option({ short: '-m' })],
    rest: new Operand({ type: 'path' }) }),
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
    rest: new Operand({ type: 'path' }) }),
  rmdir: new CommandSpec({
    options: [new Option({ short: '-v' })],
    rest: new Operand({ type: 'path' }) }),
  touch: new CommandSpec({
    options: [
      new Option({ short: '-c' }),
      new Option({ short: '-r', type: 'path' }),
      new Option({ short: '-d', type: 'str' }),
    ],
    rest: new Operand({ type: 'path' }) }),
  truncate: new CommandSpec({
    options: [new Option({ short: '-s', long: '--size', type: 'str' })],
    rest: new Operand({ type: 'path' }) }),
  unlink: new CommandSpec({ rest: new Operand({ type: 'path' }) }) }
