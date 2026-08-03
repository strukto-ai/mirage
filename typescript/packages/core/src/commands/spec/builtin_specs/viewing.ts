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
  cat: new CommandSpec({
    options: [
      new Option({ short: '-n', long: '--number' }),
      new Option({ short: '-b', long: '--number-nonblank' }),
      new Option({ short: '-E', long: '--show-ends' }),
      new Option({ short: '-T', long: '--show-tabs' }),
      new Option({ short: '-v', long: '--show-nonprinting' }),
      new Option({ short: '-e' }),
      new Option({ short: '-t' }),
      new Option({ short: '-A', long: '--show-all' }),
      new Option({ short: '-s', long: '--squeeze-blank' }),
      new Option({ short: '-u' }),
    ],
    rest: new Operand({ type: 'path' }) }),
  column: new CommandSpec({
    options: [
      new Option({ short: '-t' }),
      new Option({ short: '-s', type: 'str' }),
      new Option({ short: '-o', type: 'str' }),
    ],
    rest: new Operand({ type: 'path' }) }),
  expand: new CommandSpec({
    options: [
      new Option({ short: '-t', long: '--tabs', type: 'str' }),
      new Option({ short: '-i', long: '--initial' }),
    ],
    rest: new Operand({ type: 'path' }) }),
  fmt: new CommandSpec({
    options: [
      new Option({ short: '-w', long: '--width', type: 'str' }),
      new Option({ short: '-g', long: '--goal', type: 'str' }),
      new Option({ short: '-c', long: '--crown-margin' }),
      new Option({ short: '-p', long: '--prefix', type: 'str' }),
      new Option({ short: '-s', long: '--split-only' }),
      new Option({ short: '-t', long: '--tagged-paragraph' }),
      new Option({ short: '-u', long: '--uniform-spacing' }),
    ],
    rest: new Operand({ type: 'path' }) }),
  fold: new CommandSpec({
    options: [
      new Option({ short: '-w', long: '--width', type: 'str' }),
      new Option({ short: '-s', long: '--spaces' }),
      new Option({ short: '-b', long: '--bytes' }),
      new Option({ short: '-c', long: '--characters' }),
    ],
    rest: new Operand({ type: 'path' }) }),
  head: new CommandSpec({
    options: [
      new Option({
        short: '-n',
        long: '--lines',
        type: 'str',
        numericShorthand: true }),
      new Option({ short: '-c', long: '--bytes', type: 'str' }),
      new Option({ short: '-q', long: '--quiet' }),
      new Option({ long: '--silent' }),
      new Option({ short: '-v', long: '--verbose' }),
      new Option({ short: '-z', long: '--zero-terminated' }),
    ],
    rest: new Operand({ type: 'path' }) }),
  look: new CommandSpec({
    options: [new Option({ short: '-f' })],
    positional: [new Operand({ type: 'str' }), new Operand({ type: 'path' })] }),
  nl: new CommandSpec({
    options: [
      new Option({ short: '-b', long: '--body-numbering', type: 'str' }),
      new Option({ short: '-d', long: '--section-delimiter', type: 'str' }),
      new Option({ short: '-f', long: '--footer-numbering', type: 'str' }),
      new Option({ short: '-h', long: '--header-numbering', type: 'str' }),
      new Option({ short: '-l', long: '--join-blank-lines', type: 'str' }),
      new Option({ short: '-n', long: '--number-format', type: 'str' }),
      new Option({ short: '-p', long: '--no-renumber' }),
      new Option({ short: '-v', long: '--starting-line-number', type: 'str' }),
      new Option({ short: '-i', long: '--line-increment', type: 'str' }),
      new Option({ short: '-w', long: '--number-width', type: 'str' }),
      new Option({ short: '-s', long: '--number-separator', type: 'str' }),
    ],
    rest: new Operand({ type: 'path' }) }),
  od: new CommandSpec({
    options: [
      new Option({ short: '-A', long: '--address-radix', type: 'str' }),
      new Option({ short: '-j', long: '--skip-bytes', type: 'str' }),
      new Option({ short: '-N', long: '--read-bytes', type: 'str' }),
      new Option({ short: '-t', long: '--format', type: 'str', multiple: true }),
    ],
    rest: new Operand({ type: 'path' }) }),
  rev: new CommandSpec({ rest: new Operand({ type: 'path' }) }),
  tac: new CommandSpec({
    options: [
      new Option({ short: '-b', long: '--before' }),
      new Option({ short: '-r', long: '--regex' }),
      new Option({ short: '-s', long: '--separator', type: 'str' }),
    ],
    rest: new Operand({ type: 'path' }) }),
  tail: new CommandSpec({
    options: [
      new Option({ short: '-n', type: 'str', numericShorthand: true }),
      new Option({ short: '-c', type: 'str' }),
      new Option({ short: '-q' }),
      new Option({ short: '-v' }),
      new Option({ short: '-f', long: '--follow' }),
    ],
    rest: new Operand({ type: 'path' }) }),
  unexpand: new CommandSpec({
    options: [
      new Option({ short: '-t', long: '--tabs', type: 'str' }),
      new Option({ short: '-a', long: '--all' }),
      new Option({ long: '--first-only' }),
    ],
    rest: new Operand({ type: 'path' }) }) }
