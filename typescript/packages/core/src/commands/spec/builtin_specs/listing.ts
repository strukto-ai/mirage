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
    ],
    rest: new Operand({ type: 'path' }),
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
      new Option({ short: '-a' }),
      new Option({ short: '-A' }),
      new Option({ short: '-h' }),
      new Option({ short: '-t' }),
      new Option({ short: '-S' }),
      new Option({ short: '-r' }),
      new Option({ short: '-1' }),
      new Option({ short: '-R' }),
      new Option({ short: '-d' }),
      new Option({ short: '-F' }),
      new Option({ short: '-L' }),
      // Accepted no-op like grep --color (#471).
      new Option({ long: '--color', type: 'str', valueOptional: true }),
    ],
    rest: new Operand({ type: 'path' }),
  }),
  pwd: new CommandSpec({
    options: [new Option({ short: '-P' }), new Option({ short: '-L' })],
    rest: new Operand({ type: 'str' }),
  }),
  stat: new CommandSpec({
    options: [
      new Option({ short: '-c', type: 'str' }),
      new Option({ short: '-f', type: 'str' }),
      new Option({ short: '-L' }),
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
    ],
    rest: new Operand({ type: 'path' }),
  }),
}
