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

import { expect, it } from 'vitest'

import type { CommitFacts } from './format.ts'
import { CommitGraph } from './graph.ts'

// Every expected graph below is what git 2.47.3 prints for the same history,
// built with fast-import and walked with --all. Mirrors test_graph.py.

/** Commits in walk order from `name: parents` lines. */
function walk(spec: string): CommitFacts[] {
  return spec
    .trim()
    .split('\n')
    .map((line) => {
      const [name = '', parents = ''] = line.split(':')
      return {
        oid: name.trim(),
        tree: '',
        message: name.trim(),
        authorName: '',
        authorEmail: '',
        authorTime: 0,
        authorTimezoneMinutes: 0,
        committerName: '',
        committerEmail: '',
        committerTime: 0,
        committerTimezoneMinutes: 0,
        parents: parents.split(' ').filter((each) => each !== ''),
      }
    })
}

interface LogOptions {
  /** The names of the printed commits; all when absent. */
  readonly shown?: string
  /** The lines of text per commit. */
  readonly lines?: number
  /** A separator line between commits, as `--format=format:%s%n` prints. */
  readonly separated?: boolean
  readonly firstParent?: boolean
}

/** What a log prints with the graph, each commit's text its name. */
function log(walked: CommitFacts[], options: LogOptions = {}): string[] {
  const ids = new Set(walked.map((each) => each.oid))
  const printed = options.shown === undefined ? ids : new Set(options.shown.split(' '))
  const graph = new CommitGraph((oid) => ids.has(oid), options.firstParent ?? false)
  let out = ''
  for (const each of walked) {
    graph.walk(each)
    if (!printed.has(each.oid)) continue
    if (out !== '' && options.separated === true) out += graph.filler() + '\n'
    out += graph.leadIn() + graph.around(`${each.oid}\n`.repeat(options.lines ?? 1))
  }
  return out.split('\n').slice(0, -1)
}

it('draws a merge and collapses its branch line', () => {
  expect(log(walk('M: C B\nB: A\nC: A\nA:'))).toEqual([
    '*   M',
    '|\\  ',
    '| * B',
    '* | C',
    '|/  ',
    '* A',
  ])
})

it('spreads the lines right of an octopus before its row', () => {
  const walked = walk('K: P M S\nS: B\nM: Q0 Q1 Q2\nQ2: B\nQ1: B\nQ0: B\nP: B\nB:')
  expect(log(walked)).toEqual([
    '*-.   K',
    '|\\ \\  ',
    '| | * S',
    '| | |     ',
    '| |  \\    ',
    '| *-. \\   M',
    '| |\\ \\ \\  ',
    '| | | * | Q2',
    '| | | |/  ',
    '| | * / Q1',
    '| | |/  ',
    '| * / Q0',
    '| |/  ',
    '* / P',
    '|/  ',
    '* B',
  ])
})

it('sends a first parent waiting to the left straight to it', () => {
  const walked = walk('K: P M S\nS: B\nM: P Q1 Q2 Q3\nQ3: B\nQ2: B\nQ1: B\nP: B\nB:')
  expect(log(walked).slice(5, 7)).toEqual(['| *-. \\   M', '|/|\\ \\ \\  '])
})

it('glides under standing columns', () => {
  const walked = walk(
    'K: P M\nM: P Q1 Q2\nQ2: B\nQ1: B\nP: B\nJ: S\nI: S R1 R2\nR2: B\nR1: B\nS: B\nB:',
  )
  expect(log(walked).slice(9, 18)).toEqual([
    '| * J',
    '| | *   I',
    '| |/|\\  ',
    '| | | * R2',
    '| |_|/  ',
    '|/| |   ',
    '| | * R1',
    '| |/  ',
    '|/|   ',
  ])
})

it('follows first parents only', () => {
  expect(log(walk('K: P M S\nP: B\nB:'), { firstParent: true })).toEqual(['* K', '* P', '* B'])
})

it('stands the lines right of a lead and two parents a cell over in the separator', () => {
  const walked = walk('K: P M S\nS: B\nM: P Q1 Q2\nQ2: B\nQ1: B\nP: B\nB:')
  expect(log(walked, { lines: 2, separated: true }).slice(3, 8)).toEqual([
    '| | * S',
    '| | | S',
    '| |  |  ',
    '| * |   M',
    '|/|\\ \\  M',
  ])
})

it('widens the separator for the line it stands over', () => {
  const walked = walk('K: P M S\nM: P Q1 S\nS: B\nQ1: B\nP: B\nB:')
  expect(log(walked, { lines: 2, separated: true }).slice(0, 5)).toEqual([
    '*-.   K',
    '|\\ \\  K',
    '| |  | ',
    '| * | M',
    '|/|\\| M',
  ])
})

it('makes the separator the first row of an octopus spreading lines', () => {
  const walked = walk('K: P M S\nS: B\nM: P Q1 Q2 Q3\nQ3: B\nQ2: B\nQ1: B\nP: B\nB:')
  expect(log(walked, { lines: 2, separated: true }).slice(3, 9)).toEqual([
    '| | * S',
    '| | | S',
    '| | |     ',
    '| |  \\    ',
    '| *-. \\   M',
    '|/|\\ \\ \\  M',
  ])
})

it('marks skipped commits', () => {
  const walked = walk('T: Z\nO: A B C\nC: Z\nB: Z\nA: Z\nZ:')
  expect(log(walked, { shown: 'T B Z' })).toEqual([
    '* T',
    '...   ',
    '| | * B',
    '| |/  ',
    '|/|   ',
    '...',
    '* Z',
  ])
})

it('lets the skip row stand for the separator', () => {
  const walked = walk('T: Z\nO: A B C\nC: Z\nB: Z\nA: Z\nZ:')
  expect(log(walked, { shown: 'T B Z', lines: 2, separated: true })).toEqual([
    '* T',
    '| T',
    '...   ',
    '| | * B',
    '| |/  B',
    '|/|   ',
    '...',
    '* Z',
    '  Z',
  ])
})

it('pads a further header of a drawn commit', () => {
  const walked = walk('M: C B\nB: A\nC: A\nA:')
  const ids = new Set(walked.map((each) => each.oid))
  const graph = new CommitGraph((oid) => ids.has(oid), false)
  const [merge] = walked
  if (merge === undefined) throw new Error('missing merge')
  graph.walk(merge)
  let out = graph.leadIn() + graph.around('M\n')
  out += graph.filler() + '\n' + graph.filler() + 'A\tM.txt\n'
  out += graph.leadIn() + graph.around('M\n')
  expect(out.split('\n').slice(0, -1)).toEqual(['*   M', '|\\  ', '| | ', '| | A\tM.txt', '| | M'])
})

it('widens rows for an octopus spreading past its parents', () => {
  expect(log(walk('K: A B M C\nM: A B D C\nC:\nD:\nB:\nA:'))).toEqual([
    '*---.   K',
    '|\\ \\ \\  ',
    '| | | \\   ',
    '| | |  \\  ',
    '| | *-. | M',
    '| |/|\\ \\| ',
    '|/| | |/  ',
    '| | | * C',
    '| | * D',
    '| * B',
    '* A',
  ])
})

it('follows only a first parent that is walked', () => {
  // git log --graph --first-parent --format=%s%n%s M B ^A
  expect(log(walk('M: A B\nB: Y\nY: Z'), { lines: 2, firstParent: true })).toEqual([
    '* M',
    '  M',
    '* B',
    '| B',
    '* Y',
    '  Y',
  ])
})

it('leans lines right of a merge row into an octopus', () => {
  const walked = walk('c0: c7\nc1: c2 c8\nc2: c7 c3\nc3: c5 c4 c7\nc7: c8\nc8:\nc4:\nc5:')
  expect(log(walked)).toEqual([
    '* c0',
    '| *   c1',
    '| |\\  ',
    '| * | c2',
    '|/| | ',
    '| | \\     ',
    '| |  \\    ',
    '| *-. \\   c3',
    '| |\\ \\ \\  ',
    '| |_|/ /  ',
    '|/| | |   ',
    '* | | | c7',
    '| |_|/  ',
    '|/| |   ',
    '* | | c8',
    ' / /  ',
    '| * c4',
    '* c5',
  ])
})

it('slides under a standing column on the row it lands', () => {
  const walked = walk('c2: c9\nc3: c6 c7 c8\nc5: c9 c7 c8 c6\nc6:\nc8:\nc7:\nc9:')
  expect(log(walked)).toEqual([
    '* c2',
    '| *-.   c3',
    '| |\\ \\  ',
    '| | | | *-.   c5',
    '| |_|_|/|\\ \\  ',
    '|/| | |/ / /  ',
    '| | |/| / /   ',
    '| | | |/ /    ',
    '| | |_| /     ',
    '| |/| |       ',
    '| * | | c6',
    '|  / /  ',
    '| | * c8',
    '| * c7',
    '* c9',
  ])
})

it('keeps a reach left short by a beside parent as a line', () => {
  const walked = walk('c0: c1 c7\nc1: c6 c3 c2\nc2: c6 c3 c9 c7\nc7:\nc9:\nc3:\nc6:')
  expect(log(walked)).toEqual([
    '*   c0',
    '|\\  ',
    '| \\     ',
    '|  \\    ',
    '*-. \\   c1',
    '|\\ \\ \\  ',
    '| | | \\   ',
    '| | |  \\  ',
    '| | *-. | c2',
    '| |/|\\ \\| ',
    '|/| | |/  ',
    '| | | * c7',
    '| | * c9',
    '| * c3',
    '* c6',
  ])
})

it('moves lines that start a row together as one', () => {
  const walked = walk('c0: c5 c9\nc1: c4 c8\nc4: c7 c8 c5\nc5: c8 c9 c7\nc7:\nc9:\nc8:')
  expect(log(walked).slice(8, 20)).toEqual([
    '| |_|_|/ /  ',
    '|/| | | /   ',
    '| | | |/    ',
    '| | | |     ',
    '|  \\ \\ \\    ',
    '*-. \\ \\ \\   c5',
    '|\\ \\ \\ \\ \\  ',
    '| | |/ / /  ',
    '| |/| / /   ',
    '| | |/ /    ',
    '| |_| /     ',
    '|/| |       ',
  ])
})

it('widens the separator by an octopus dashes', () => {
  const walked = walk('c0: c3 c5 c1\nc1: c3 c5 c2 c4\nc4:\nc2:\nc5:\nc3:')
  expect(log(walked, { lines: 2, separated: true }).slice(0, 5)).toEqual([
    '*-.   c0',
    '|\\ \\  c0',
    '| | |    ',
    '| | *-. c1',
    '| |/|\\ \\c1',
  ])
})
