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
  gunzip: new CommandSpec({
    options: [
      new Option({ short: '-k' }),
      new Option({ short: '-f' }),
      new Option({ short: '-c' }),
      new Option({ short: '-t' }),
    ],
    rest: new Operand({ type: 'path' }),
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
    rest: new Operand({ type: 'path' }),
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
      // -h archives what a symlink points at instead of the link.
      new Option({ short: '-h' }),
      new Option({ short: '-f', type: 'path' }),
      // Every occurrence is kept, in order: GNU chdirs at each one and
      // fails at the first it cannot enter, so the planner has to see
      // them all, not just the last.
      new Option({ short: '-C', type: 'path', multiple: true }),
      new Option({ long: '--strip-components', type: 'str' }),
      new Option({ long: '--exclude', type: 'str' }),
    ],
    rest: new Operand({ type: 'path' }),
    // `tar xzf a.tgz` is the spelling everyone types.
    oldOptionStyle: true,
    // -C is a chdir for the operands after it, not a flag the command
    // reads once: `tar -cf a.tar -C d x` archives d/x as `x`.
    operandBase: '-C',
  }),
  unzip: new CommandSpec({
    options: [
      new Option({ short: '-o' }),
      new Option({ short: '-l' }),
      new Option({ short: '-d', type: 'path' }),
      new Option({ short: '-q' }),
      new Option({ short: '-p' }),
      new Option({ short: '-t' }),
    ],
    // The archive is the only path operand; everything after it is an
    // Info-ZIP member pattern matched against archive entry names, never
    // a filesystem path.
    positional: [new Operand({ type: 'path' })],
    rest: new Operand({ type: 'str' }),
  }),
  zcat: new CommandSpec({ rest: new Operand({ type: 'path' }) }),
  zip: new CommandSpec({
    options: [
      new Option({ short: '-r' }),
      new Option({ short: '-j' }),
      new Option({ short: '-q' }),
      // -y stores a symlink as a symlink; without it zip archives what
      // the link points at, which is tar's -h inverted.
      new Option({ short: '-y' }),
      // Info-ZIP reads -x as a variadic list of patterns; mirage takes
      // one per occurrence, since its spec has no variadic option value
      // and `-x a -x b` says the same thing.
      new Option({ short: '-x', type: 'str', multiple: true }),
    ],
    rest: new Operand({ type: 'path' }),
  }),
}
