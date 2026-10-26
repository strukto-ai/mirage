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
import { MountMode } from '../../../../types.ts'
import { RAMVFS } from '../../../../vfs/ram/ram.ts'
import { Workspace } from '../../../../workspace/workspace/workspace.ts'
import { defaultDirectory, remoteHead } from './clone.ts'
import { GIT } from './index.ts'
import type { Advertisement } from './transport.ts'

const C = 'c'.repeat(40)
const B = 'b'.repeat(40)
const T = 't'.repeat(40)
const A = 'a'.repeat(40)
const ADV: Advertisement = {
  refs: new Map([
    ['HEAD', C],
    ['refs/heads/main', C],
    ['refs/heads/topic', B],
    ['refs/tags/v1', T],
  ]),
  peeled: new Map([['refs/tags/v1', A]]),
  head: 'refs/heads/main',
}

it.each([
  ['src', 'src'],
  ['src/', 'src'],
  ['src/.git', 'src'],
  ['repos/proj.git', 'proj'],
  ['repos/proj.git/', 'proj'],
  ['https://github.com/octocat/Hello-World.git', 'Hello-World'],
  ['git@github.com:octocat/Hello-World', 'Hello-World'],
])('names the clone of %s after the repository', (url, expected) => {
  expect(defaultDirectory(url)).toBe(expected)
})

it.each([
  [null, ['main', C]],
  ['topic', ['topic', B]],
  ['v1', [null, A]],
  ['nosuch', ['nosuch', null]],
])('checks out HEAD or the named branch or tag for %s', (chosen, expected) => {
  expect(remoteHead(ADV, chosen)).toEqual(expected)
})

it('checks out a detached remote HEAD detached', () => {
  const adv: Advertisement = {
    refs: new Map([
      ['HEAD', C],
      ['refs/heads/main', B],
    ]),
    peeled: new Map(),
    head: null,
  }
  expect(remoteHead(adv, null)).toEqual([null, C])
})

it('refuses a third operand as too many arguments', async () => {
  const ws = new Workspace({ '/w': new RAMVFS() }, { mode: MountMode.WRITE })
  ws.registerCli('git', GIT)
  try {
    await ws.shell('mkdir /w/b && echo x > /w/b/f')
    const result = await ws.shell('cd /w && git clone a b c')
    expect(result.exitCode).toBe(129)
    expect(new TextDecoder().decode(result.stderr)).toMatch(
      /^fatal: Too many arguments\.\n\nusage: git clone /,
    )
  } finally {
    await ws.close()
  }
})
