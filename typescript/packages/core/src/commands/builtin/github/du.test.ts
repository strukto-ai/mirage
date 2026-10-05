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

import { afterEach, expect, it, vi } from 'vitest'
import { GitHubAccessor } from '../../../accessor/github.ts'
import type { GitHubTransport } from '../../../core/github/client.ts'
import type { TreeEntry } from '../../../core/github/tree_entry.ts'
import { FileStat, FileType, PathSpec } from '../../../types.ts'
import { materialize } from '../../../io/types.ts'
import type { FlagValue } from '../../spec/types.ts'
import { IO } from './io.ts'
import { GITHUB_DU } from './du.ts'

vi.mock('../../../core/github/tree.ts', () => ({
  ensureTree: vi.fn().mockResolvedValue(undefined),
}))

afterEach(() => vi.restoreAllMocks())

const TREE: Record<string, TreeEntry> = {
  'Banana.md': { path: 'Banana.md', type: 'blob', sha: 's0', size: 2 },
  docs: { path: 'docs', type: 'tree', sha: 's1', size: null },
  'docs/a.md': { path: 'docs/a.md', type: 'blob', sha: 's2', size: 100 },
  'docs/b.md': { path: 'docs/b.md', type: 'blob', sha: 's3', size: 50 },
  'docs/c.md': { path: 'docs/c.md', type: 'blob', sha: 's5', size: null },
  'readme.txt': { path: 'readme.txt', type: 'blob', sha: 's4', size: 7 },
  vendor: { path: 'vendor', type: 'tree', sha: 's6', size: null },
}

async function runDu(
  accessor: GitHubAccessor,
  operand: string,
  flags: Record<string, FlagValue>,
): Promise<[string, number, string]> {
  const cmd = GITHUB_DU[0]
  if (cmd === undefined) throw new Error('du not registered')
  const result = await cmd.fn(accessor, [PathSpec.fromStrPath(operand)], [], {
    stdin: null,
    flags,
    filetypeFns: null,
    cwd: '/',
  })
  if (result === null) throw new Error('du returned nothing')
  const [out, io] = result
  const bytes =
    out === null ? new Uint8Array() : out instanceof Uint8Array ? out : await materialize(out)
  return [new TextDecoder().decode(bytes), io.exitCode, await io.stderrStr()]
}

it.each([
  ['/', {}, '150\t/docs\n0\t/vendor\n159\t/\n'],
  [
    '/',
    { a: true },
    '2\t/Banana.md\n100\t/docs/a.md\n50\t/docs/b.md\n0\t/docs/c.md\n150\t/docs\n7\t/readme.txt\n0\t/vendor\n159\t/\n',
  ],
  ['/docs', { s: true }, '150\t/docs\n'],
  ['/readme.txt', { a: true }, '7\t/readme.txt\n'],
])('du %s %o sums the live tree', async (operand, flags, expected) => {
  vi.spyOn(IO, 'stat').mockImplementation((_a, p) => {
    const entry = TREE[p.vfsPath]
    return Promise.resolve(
      new FileStat({
        name: p.virtual,
        type: entry?.type === 'blob' ? FileType.FILE : FileType.DIRECTORY,
        size: entry?.size ?? null,
      }),
    )
  })
  const accessor = new GitHubAccessor({
    transport: {} as GitHubTransport,
    owner: 'o',
    repo: 'r',
    ref: 'main',
    defaultBranch: 'main',
    tree: TREE,
  })
  expect(await runDu(accessor, operand, flags)).toEqual([expected, 0, ''])
})
