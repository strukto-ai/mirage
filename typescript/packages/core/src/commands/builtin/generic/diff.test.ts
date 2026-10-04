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
// diff's stdin operands and as-typed names, pinned on GNU diffutils 3.10.
// Mirrors python/tests/commands/builtin/generic/test_diff.py.

import { describe, expect, it } from 'vitest'
import { diffGeneric, switchWords } from './diff.ts'
import { FileStat, FileType, PathSpec } from '../../../types.ts'
import type { CommandOpts } from '../../config.ts'

const ENC = new TextEncoder()

function operand(raw: string, virtual: string): PathSpec {
  return new PathSpec({ virtual, directory: virtual, vfsPath: virtual.slice(3), rawPath: raw })
}

const DASH = operand('-', '/d/-')
const DEV_STDIN = new PathSpec({ virtual: '/dev/stdin', directory: '/dev', vfsPath: 'stdin' })
const DIRS: Record<string, string[]> = { '/d/sub': ['x'], '/d/sub2': ['x', 'y'] }

function readdir(p: PathSpec): Promise<string[]> {
  return Promise.resolve(DIRS[p.virtual] ?? [])
}

function stat(p: PathSpec): Promise<FileStat> {
  const type = p.virtual in DIRS ? FileType.DIRECTORY : FileType.FILE
  return Promise.resolve(new FileStat({ name: p.virtual.split('/').pop() ?? '', type }))
}

describe('diffGeneric with stdin', () => {
  it('takes two stdin operands as one file', async () => {
    const unread = (p: PathSpec): AsyncIterable<Uint8Array> => {
      throw new Error(`read ${p.virtual}`)
    }
    const opts = { flags: {}, stdin: ENC.encode('abc') } as unknown as CommandOpts
    const [out, io] = await diffGeneric([DASH, DEV_STDIN], opts, unread, readdir, stat)
    expect([out, io.exitCode]).toEqual([null, 0])
  })

  it('keeps the option words as typed for the header', () => {
    expect(switchWords(['-ru', '--exclude', '.git', 'a', 'b', '-x*.log'])).toEqual([
      '-ru',
      '--exclude',
      '.git',
      '-x*.log',
    ])
    expect(switchWords(['--exclude=.git', '-r', 'a', '--', '-b'])).toEqual([
      '--exclude=.git',
      '-r',
      '--',
    ])
    expect(switchWords(['-rx', 'pat', '-U', '1', 'a', 'b'])).toEqual(['-rx', 'pat', '-U', '1'])
  })
})
