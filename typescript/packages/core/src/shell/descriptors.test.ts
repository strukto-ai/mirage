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
import { FD_BOTH, FD_CLOSE } from './constants.ts'
import { badDescriptorLine, unsupportedDescriptor } from './descriptors.ts'
import { getRedirects } from './helpers.ts'
import { RedirectKind, type Redirect, type TSNodeLike } from './types.ts'
import { getTestParser } from '../workspace/fixtures/workspace_fixture.ts'

async function redirects(line: string): Promise<Redirect[]> {
  const parser = await getTestParser()
  const node = parser.parse(line).namedChildren[0] as TSNodeLike
  return getRedirects(node)[1]
}

describe('redirect parser keeps the descriptor as typed', () => {
  const cases: [string, number, unknown, RedirectKind][] = [
    ['echo x > f', 1, 'f', RedirectKind.STDOUT],
    ['echo x 2> f', 2, 'f', RedirectKind.STDERR],
    ['echo x 2>&1', 2, 1, RedirectKind.STDERR_TO_STDOUT],
    ['echo x >&2', 1, 2, RedirectKind.STDOUT],
    ['echo x >&-', 1, FD_CLOSE, RedirectKind.STDOUT],
    ['echo x 2>&-', 2, FD_CLOSE, RedirectKind.STDERR],
    ['echo x <&-', 0, FD_CLOSE, RedirectKind.STDIN],
    ['echo x <&0', 0, 0, RedirectKind.STDIN],
    ['echo x 3> f', 3, 'f', RedirectKind.STDOUT],
    ['echo x 3< f', 3, 'f', RedirectKind.STDIN],
    ['echo x <&3', 0, 3, RedirectKind.STDIN],
    ['echo x >&3', 1, 3, RedirectKind.STDOUT],
    ['echo x 2>&3', 2, 3, RedirectKind.STDERR],
    ['echo x 3>&1', 3, 1, RedirectKind.STDOUT],
    ['echo x 3>&-', 3, FD_CLOSE, RedirectKind.STDOUT],
    ['echo x &> f', FD_BOTH, 'f', RedirectKind.STDOUT],
    ['echo x >& f', FD_BOTH, 'f', RedirectKind.STDOUT],
  ]
  for (const [line, fd, target, kind] of cases) {
    it(line, async () => {
      const [r] = await redirects(line)
      expect([r?.fd, r?.target, r?.kind]).toEqual([fd, target, kind])
    })
  }

  it('append and clobber flags', async () => {
    expect((await redirects('echo x >> f'))[0]?.append).toBe(true)
    expect((await redirects('echo x >| f'))[0]?.clobber).toBe(true)
    expect((await redirects('echo x &>> f'))[0]?.append).toBe(true)
  })
})

describe('unsupportedDescriptor', () => {
  it('accepts the shell descriptors and the two sentinels', async () => {
    for (const line of [
      'echo x > f',
      'echo x 2>&1',
      'echo x >&-',
      'echo x <&-',
      'echo x &> f',
      'echo x >&2',
      'echo x 1>&1',
      'cat < f',
    ]) {
      expect(unsupportedDescriptor(await redirects(line))).toBeNull()
    }
  })

  it('names the first descriptor above 2, claimed or duplicated from', async () => {
    for (const [line, fd] of [
      ['echo x 3> f', 3],
      ['echo x 3< f', 3],
      ['echo x <&3', 3],
      ['echo x >&3', 3],
      ['echo x 2>&3', 3],
      ['echo x 3>&1', 3],
      ['echo x 3>&-', 3],
      ['echo x > f 4>&1', 4],
    ] as [string, number][]) {
      expect(unsupportedDescriptor(await redirects(line))).toBe(fd)
    }
    expect(new TextDecoder().decode(badDescriptorLine(3))).toBe('3: Bad file descriptor\n')
  })
})
