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

import { mountKey } from '../../../utils/key_prefix.ts'
import { describe, expect, it } from 'vitest'
import { FileStat, FileType, PathSpec } from '../../../types.ts'
import { rstripSlash } from '../../../utils/slash.ts'
import type { CommandOpts } from '../../config.ts'
import { treeGeneric } from './tree.ts'

const DEC = new TextDecoder()

const FOLDERS = new Set(['/', '/docs', '/.secret'])

function key(p: PathSpec): string {
  return rstripSlash(p.virtual) || '/'
}

function spec(path: string): PathSpec {
  return new PathSpec({
    virtual: path,
    directory: path,
    resolved: false,
    resourcePath: mountKey(path, ''),
  })
}

function opts(flags: Record<string, string | boolean | string[]>): CommandOpts {
  return {
    stdin: null,
    flags,
    filetypeFns: null,
    cwd: '/',
    resource: null,
  } as unknown as CommandOpts
}

const stat = (p: PathSpec): Promise<FileStat> =>
  Promise.resolve(
    new FileStat({
      name: key(p).split('/').pop() ?? '',
      type: FOLDERS.has(key(p)) ? FileType.DIRECTORY : FileType.TEXT,
    }),
  )

const boxReaddir = (p: PathSpec): Promise<string[]> => {
  const k = key(p)
  if (k === '/') return Promise.resolve(['/docs/', '/readme.txt', '/.secret/'])
  if (k === '/docs') return Promise.resolve(['/docs/a.txt'])
  return Promise.resolve([])
}

const s3Readdir = (p: PathSpec): Promise<string[]> => {
  const k = key(p)
  if (k === '/') return Promise.resolve(['/docs', '/readme.txt', '/.secret'])
  if (k === '/docs') return Promise.resolve(['/docs/a.txt'])
  return Promise.resolve([])
}

async function run(
  readdir: (p: PathSpec) => Promise<string[]>,
  flags: Record<string, string | boolean | string[]>,
): Promise<string> {
  const [out] = (await treeGeneric([spec('/')], opts(flags), readdir, stat)) as [
    Uint8Array,
    unknown,
  ]
  return DEC.decode(out)
}

describe('treeGeneric with trailing-slash folder entries', () => {
  it('shows folder names and hides hidden folders by default', async () => {
    expect(await run(boxReaddir, {})).toBe('├── docs\n│   └── a.txt\n└── readme.txt\n')
  })

  it('shows hidden folders by name with -a', async () => {
    expect(await run(boxReaddir, { a: true })).toBe(
      '├── .secret\n├── docs\n│   └── a.txt\n└── readme.txt\n',
    )
  })

  it('produces identical output for slash-free entries', async () => {
    expect(await run(s3Readdir, {})).toBe('├── docs\n│   └── a.txt\n└── readme.txt\n')
  })
})
