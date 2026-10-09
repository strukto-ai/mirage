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
  gunzip: new CommandSpec({
    arguments: [
      new Argument('-k', { action: 'store_true' }),
      new Argument('-f', { action: 'store_true' }),
      new Argument('-c', { action: 'store_true' }),
      new Argument('-t', { action: 'store_true' }),
      new Argument('-q', { action: 'store_true' }),
      new Argument('-S'),
      new Argument('paths', { metavar: '', type: 'path', nargs: '*' }),
    ],
  }),
  gzip: new CommandSpec({
    arguments: [
      new Argument('-d', { action: 'store_true' }),
      new Argument('-k', { action: 'store_true' }),
      new Argument('-f', { action: 'store_true' }),
      new Argument('-c', { action: 'store_true' }),
      new Argument('-q', { action: 'store_true' }),
      new Argument('-S'),
      new Argument('-1', { action: 'store_true' }),
      new Argument('-2', { action: 'store_true' }),
      new Argument('-3', { action: 'store_true' }),
      new Argument('-4', { action: 'store_true' }),
      new Argument('-5', { action: 'store_true' }),
      new Argument('-6', { action: 'store_true' }),
      new Argument('-7', { action: 'store_true' }),
      new Argument('-8', { action: 'store_true' }),
      new Argument('-9', { action: 'store_true' }),
      new Argument('paths', { metavar: '', type: 'path', nargs: '*' }),
    ],
  }),
  tar: new CommandSpec({
    arguments: [
      new Argument(['-c', '--create'], { action: 'store_true' }),
      new Argument(['-x', '--extract'], { action: 'store_true' }),
      new Argument(['-t', '--list'], { action: 'store_true' }),
      new Argument(['-z', '--gzip'], { action: 'store_true' }),
      new Argument(['-j', '--bzip2'], { action: 'store_true' }),
      new Argument(['-J', '--xz'], { action: 'store_true' }),
      new Argument(['-v', '--verbose'], { action: 'store_true' }),
      new Argument(['-h', '--dereference'], { action: 'store_true' }),
      new Argument(['-O', '--to-stdout'], { action: 'store_true' }),
      new Argument(['-f', '--file'], { type: 'path' }),
      new Argument(['-C', '--directory'], { action: 'append', type: 'path' }),
      new Argument('--strip-components'),
      new Argument('--exclude'),
      new Argument('--one-file-system', { action: 'store_true' }),
      new Argument('paths', { metavar: '', type: 'path', nargs: '*', textWhen: ['-x', '-t'] }),
    ],
    oldOptionStyle: true,
    operandBase: '-C',
  }),
  unzip: new CommandSpec({
    arguments: [
      new Argument('-o', { action: 'store_true' }),
      new Argument('-n', { action: 'store_true' }),
      new Argument('-l', { action: 'store_true' }),
      new Argument('-d', { type: 'path' }),
      new Argument('-q', { action: 'store_true' }),
      new Argument('-p', { action: 'store_true' }),
      new Argument('-t', { action: 'store_true' }),
      new Argument('-v', { action: 'store_true' }),
      new Argument('-x', { action: 'append' }),
      new Argument('-Z', { action: 'store_true' }),
      new Argument('-1', { action: 'store_true' }),
      new Argument('-2', { action: 'store_true' }),
      new Argument('-s', { action: 'store_true' }),
      new Argument('-m', { action: 'store_true' }),
      new Argument('-h', { action: 'store_true' }),
      new Argument('path', { metavar: '', type: 'path', nargs: '?' }),
      new Argument('texts', { metavar: '', nargs: '*' }),
    ],
  }),
  // zcat is `gzip -cd`: -f copies input that is not gzip, -q drops the
  // warnings, and -S names the suffix a missing name is retried with.
  zcat: new CommandSpec({
    arguments: [
      new Argument('-f', { action: 'store_true' }),
      new Argument('-q', { action: 'store_true' }),
      new Argument('-S'),
      new Argument('paths', { metavar: '', type: 'path', nargs: '*' }),
    ],
  }),
  zip: new CommandSpec({
    arguments: [
      new Argument('-r', { action: 'store_true' }),
      new Argument('-j', { action: 'store_true' }),
      new Argument('-q', { action: 'store_true' }),
      new Argument('-y', { action: 'store_true' }),
      new Argument('-x', { action: 'append' }),
      new Argument('paths', { metavar: '', type: 'path', nargs: '*' }),
    ],
  }),
}
