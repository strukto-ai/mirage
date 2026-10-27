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
import { fsError } from '../../../../errors/fs.ts'
import { posixPhrase } from '../../../../errors/posix.ts'
import { FileStat, FileType, PathSpec } from '../../../../types.ts'
import type { LinkView } from '../../../../view/types.ts'
import { scanOperand } from './walk.ts'

const REFUSALS = ['EACCES', 'EPERM', 'EROFS'] as const

function linkTo(link: string, target: string): LinkView {
  const row = new FileStat({ name: link, type: FileType.SYMLINK, size: target.length })
  return {
    statAt: (p) => (p === link ? row : null),
    subtree: () => [],
    resolve: (p) => (p === link ? target : p),
    exists: () => Promise.resolve(true),
    targetStat: () => Promise.resolve(null),
  }
}

describe('scanOperand', () => {
  // Mirrors python's test_a_refused_operand_is_one_fatal_problem_said_as_refused.
  // GNU tar: `Cannot stat: Permission denied`, the other operands go on; a
  // refusal keeps its own errno.
  it.each(REFUSALS)('says a refused operand is refused: %s', async (code) => {
    const scan = await scanOperand(PathSpec.fromStrPath('/rd/b.txt', 'rd/b.txt'), {
      stat: (path) => Promise.reject(fsError(path, code)),
      walk: () => Promise.reject(new Error('no walk')),
      dereference: false,
      recurse: true,
    })
    expect(scan.missing).toBe(true)
    expect(scan.problems).toEqual([{ path: '/rd/b.txt', reason: posixPhrase(code), fatal: true }])
  })

  // Mirrors python's test_a_link_to_a_refused_target_is_one_fatal_problem.
  // GNU tar -h: `l: Cannot stat: Permission denied`, the rest go on.
  it.each(REFUSALS)('says a link to a refused target is refused: %s', async (code) => {
    const scan = await scanOperand(PathSpec.fromStrPath('/rd/l', 'rd/l'), {
      stat: (path) => Promise.reject(fsError(path, code)),
      walk: () => Promise.reject(new Error('no walk')),
      links: linkTo('/rd/l', '/rd/b.txt'),
      dereference: true,
      recurse: true,
    })
    expect(scan.missing).toBe(true)
    expect(scan.problems).toEqual([{ path: '/rd/l', reason: posixPhrase(code), fatal: true }])
  })
})
