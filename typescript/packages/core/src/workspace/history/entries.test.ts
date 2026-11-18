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

import { describe, expect, it } from 'vitest'
import { ParseScope } from '../../shell/parse/scope.ts'
import type { TSNodeLike } from '../../shell/types.ts'
import { historyEntries } from './entries.ts'

function entries(input: string): (string | null)[] {
  const scope = new ParseScope()
  try {
    return historyEntries(scope.parse(input) as unknown as TSNodeLike).map((e) => e.text)
  } finally {
    scope.release()
  }
}

describe('historyEntries', () => {
  // Each pinned against Debian Bash 5.2.37, `bash --norc -i` with `set +H`.
  it.each([
    ['echo a\necho b; echo c\n', ['echo a', 'echo b; echo c']],
    ['for i in 1 2\ndo echo $i\ndone\n', ['for i in 1 2; do echo $i; done']],
    ['if true\nthen\necho y\nelse\necho n\nfi\n', ['if true; then echo y; else echo n; fi']],
    ['f()\n{\n:\n}\n', ['f() { :; }']],
    ['echo a |\ncat\ntrue &&\necho b\n', ['echo a | cat', 'true && echo b']],
    ['echo c \\\n  d\n', ['echo c   d']],
    ['echo "q\nr" $(echo a\necho b)\n', ['echo "q\nr" $(echo a\necho b)']],
    ['case y in\ny)\necho y\n;;\nesac\n', ['case y in y) echo y; ;; esac']],
    ['if (true)\nthen :\nfi\na=(1\n2)\n', ['if (true); then :; fi', 'a=(1 2)']],
    ['cat <<A; echo after\nbody\nA\necho z\n', ['cat <<A; echo after\nbody\nA\n', 'echo z']],
    ['if true; then cat <<A\nx\nA\nfi\n', ['if true; then cat <<A\nx\nA\n fi']],
    ['X=$(cat <<A\nx\nA\n)\n', ['X=$(cat <<A\nx\nA\n\n)']],
    ['X=$(curl a \\\n  -H b)\n', ['X=$(curl a \\\n  -H b)']],
    ['for i in 1\n# c\ndo :\ndone\n', ['for i in 1\ndo :; done']],
    ['if true # why\nthen :; fi\n', ['if true # why\nthen :; fi']],
    ['if true\n\nthen :\n   \nfi\n', ['if true;  then :;     fi']],
    ['# note\n\n   \nfalse\n', ['# note', '   ', 'false']],
    ['echo a\necho b\n   \n\t\n', ['echo a', 'echo b', '   ', '\t']],
    ['# first\n# second\n', ['# first', '# second']],
  ])('%j', (input, expected) => {
    expect(entries(input)).toEqual(expected)
  })
})

it.each([
  [
    'cat <<A <<B\na\nA\nb\nB\necho z\n',
    [
      { text: 'cat <<A <<B\na\nA\nb\nB\n', at: 0 },
      { text: 'echo z', at: 20 },
    ],
  ],
  [
    'X=$(cat <<A\na\nA\n)\ncat <<B\nb\nB\n',
    [
      { text: 'X=$(cat <<A\na\nA\n\n)', at: 0 },
      { text: 'cat <<B\nb\nB\n', at: 18 },
    ],
  ],
  [
    'echo ok\ncat <<A; (\n',
    [
      { text: 'echo ok', at: 0 },
      { text: 'cat <<A; (', at: 8 },
    ],
  ],
  ['if true; then\necho z\n', [{ text: 'if true; then\necho z', at: 0 }]],
])('preserves entry positions for %j', (source, expected) => {
  const scope = new ParseScope()
  try {
    expect(historyEntries(scope.parse(source))).toEqual(expected)
  } finally {
    scope.release()
  }
})

it('uses the last logical predecessor in a nonmonotone continuation map', () => {
  const word: TSNodeLike = {
    type: 'string',
    text: '',
    startIndex: 1,
    endIndex: 4,
    children: [],
    namedChildren: [],
    isNamed: true,
  }
  const command: TSNodeLike = {
    type: 'command',
    text: '',
    startIndex: 0,
    endIndex: 4,
    children: [word],
    namedChildren: [word],
    isNamed: true,
  }
  const root: TSNodeLike = {
    type: 'program',
    text: 'abc\n',
    sourceText: 'a\\\nb\\\nc\n',
    offsets: [0, 6, 1, 7, 8],
    startIndex: 0,
    children: [command],
    namedChildren: [command],
  }
  expect(historyEntries(root)).toEqual([{ text: 'ab\\\nc', at: 0 }])
})

it.each(['word', '|'])('keeps the later leaf on a predecessor tie ending in %j', (last) => {
  const leaves: TSNodeLike[] = (last === 'word' ? ['|', 'word'] : ['word', '|']).map((type) => ({
    type,
    text: '',
    startIndex: 0,
    endIndex: 1,
    children: [],
    namedChildren: [],
    isNamed: type === 'word',
  }))
  leaves.push({
    type: 'word',
    text: '',
    startIndex: 2,
    endIndex: 3,
    children: [],
    namedChildren: [],
    isNamed: true,
  })
  const command: TSNodeLike = {
    type: 'command',
    text: '',
    startIndex: 0,
    endIndex: 3,
    children: leaves,
    namedChildren: leaves,
    isNamed: true,
  }
  const root: TSNodeLike = {
    type: 'program',
    text: 'a\nb\n',
    startIndex: 0,
    children: [command],
    namedChildren: [command],
  }
  expect(historyEntries(root)).toEqual([{ text: last === 'word' ? 'a; b' : 'a b', at: 0 }])
})
