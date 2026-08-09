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
      new Option({ short: '-f', type: 'path' }),
      new Option({ short: '-C', type: 'path' }),
      new Option({ long: '--strip-components', type: 'str' }),
      new Option({ long: '--exclude', type: 'str' }),
    ],
    rest: new Operand({ type: 'path' }),
    // `tar xzf a.tgz` is the spelling everyone types.
    oldOptionStyle: true,
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
    ],
    rest: new Operand({ type: 'path' }),
  }),
}
