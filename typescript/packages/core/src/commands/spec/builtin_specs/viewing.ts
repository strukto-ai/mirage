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
  cat: new CommandSpec({
    arguments: [
      new Argument(['-b', '--number-nonblank'], { action: 'store_true' }),
      new Argument(['-n', '--number'], { action: 'store_true' }),
      new Argument(['-s', '--squeeze-blank'], { action: 'store_true' }),
      new Argument(['-v', '--show-nonprinting'], { action: 'store_true' }),
      new Argument(['-E', '--show-ends'], { action: 'store_true' }),
      new Argument('-e', { action: 'store_true' }),
      new Argument('-t', { action: 'store_true' }),
      new Argument(['-T', '--show-tabs'], { action: 'store_true' }),
      new Argument(['-A', '--show-all'], { action: 'store_true' }),
      new Argument('-u', { action: 'store_true' }),
      new Argument('paths', { metavar: '', type: 'path', nargs: '*' }),
    ],
  }),
  column: new CommandSpec({
    arguments: [
      new Argument('-t', { action: 'store_true' }),
      new Argument('-s'),
      new Argument('-o'),
      new Argument('paths', { metavar: '', type: 'path', nargs: '*' }),
    ],
  }),
  expand: new CommandSpec({
    arguments: [
      new Argument(['-t', '--tabs'], { action: 'append' }),
      new Argument(['-i', '--initial'], { action: 'store_true' }),
      new Argument('paths', { metavar: '', type: 'path', nargs: '*' }),
    ],
  }),
  fmt: new CommandSpec({
    arguments: [
      new Argument(['-w', '--width']),
      new Argument(['-g', '--goal']),
      new Argument(['-c', '--crown-margin'], { action: 'store_true' }),
      new Argument(['-p', '--prefix']),
      new Argument(['-s', '--split-only'], { action: 'store_true' }),
      new Argument(['-t', '--tagged-paragraph'], { action: 'store_true' }),
      new Argument(['-u', '--uniform-spacing'], { action: 'store_true' }),
      new Argument('paths', { metavar: '', type: 'path', nargs: '*' }),
    ],
  }),
  fold: new CommandSpec({
    arguments: [
      new Argument(['-w', '--width']),
      new Argument(['-s', '--spaces'], { action: 'store_true' }),
      new Argument(['-b', '--bytes'], { action: 'store_true' }),
      new Argument(['-c', '--characters'], { action: 'store_true' }),
      new Argument('paths', { metavar: '', type: 'path', nargs: '*' }),
    ],
  }),
  head: new CommandSpec({
    arguments: [
      new Argument(['-n', '--lines'], { numericShorthand: true }),
      new Argument(['-c', '--bytes']),
      new Argument(['-q', '--quiet'], { action: 'store_true' }),
      new Argument('--silent', { action: 'store_true' }),
      new Argument(['-v', '--verbose'], { action: 'store_true' }),
      new Argument(['-z', '--zero-terminated'], { action: 'store_true' }),
      new Argument('paths', { metavar: '', type: 'path', nargs: '*' }),
    ],
  }),
  look: new CommandSpec({
    arguments: [
      new Argument('-f', { action: 'store_true' }),
      new Argument('text', { metavar: '', nargs: '?' }),
      new Argument('path2', { metavar: '', type: 'path', nargs: '?' }),
    ],
  }),
  nl: new CommandSpec({
    arguments: [
      new Argument(['-b', '--body-numbering'], { action: 'append' }),
      new Argument(['-v', '--starting-line-number'], { action: 'append' }),
      new Argument(['-f', '--footer-numbering'], { action: 'append' }),
      new Argument(['-h', '--header-numbering'], { action: 'append' }),
      new Argument(['-l', '--join-blank-lines'], { action: 'append' }),
      new Argument(['-p', '--no-renumber'], { action: 'store_true' }),
      new Argument(['-s', '--number-separator']),
      new Argument(['-d', '--section-delimiter']),
      new Argument(['-i', '--line-increment'], { action: 'append' }),
      new Argument(['-w', '--number-width'], { action: 'append' }),
      new Argument(['-n', '--number-format'], { action: 'append' }),
      new Argument('paths', { metavar: '', type: 'path', nargs: '*' }),
    ],
  }),
  od: new CommandSpec({
    arguments: [
      new Argument(['-A', '--address-radix']),
      new Argument(['-j', '--skip-bytes']),
      new Argument(['-N', '--read-bytes']),
      new Argument(['-t', '--format'], { action: 'append' }),
      new Argument('-c', { action: 'store_true' }),
      new Argument('paths', { metavar: '', type: 'path', nargs: '*' }),
    ],
  }),
  rev: new CommandSpec({
    arguments: [new Argument('paths', { metavar: '', type: 'path', nargs: '*' })],
  }),
  tac: new CommandSpec({
    arguments: [
      new Argument(['-b', '--before'], { action: 'store_true' }),
      new Argument(['-r', '--regex'], { action: 'store_true' }),
      new Argument(['-s', '--separator']),
      new Argument('paths', { metavar: '', type: 'path', nargs: '*' }),
    ],
  }),
  tail: new CommandSpec({
    arguments: [
      new Argument('-n', { numericShorthand: true }),
      new Argument('-c'),
      new Argument('-q', { action: 'store_true' }),
      new Argument('-v', { action: 'store_true' }),
      new Argument(['-f', '--follow'], { nargs: '?', attachedOnly: true, shortValue: false }),
      new Argument('-F', { action: 'store_true' }),
      new Argument('--retry', { action: 'store_true' }),
      new Argument(['-s', '--sleep-interval']),
      new Argument('paths', { metavar: '', type: 'path', nargs: '*' }),
    ],
  }),
  unexpand: new CommandSpec({
    arguments: [
      new Argument(['-t', '--tabs']),
      new Argument(['-a', '--all'], { action: 'store_true' }),
      new Argument('--first-only', { action: 'store_true' }),
      new Argument('paths', { metavar: '', type: 'path', nargs: '*' }),
    ],
  }),
}
