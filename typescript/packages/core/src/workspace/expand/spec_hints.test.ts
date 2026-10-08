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
import { BUILTIN_SPECS, specOf } from '../../commands/spec/builtins.ts'
import { BaseVFS } from '../../vfs/base.ts'
import { MountMode } from '../../types.ts'
import { makeIntegrationWS, run, runResult } from '../fixtures/integration_fixture.ts'
import { MountRegistry } from '../mount/registry.ts'
import { specForCommand, specWordKinds } from './spec_hints.ts'

class StubVFS extends BaseVFS {
  override readonly name = 'stub'
  override close(): Promise<void> {
    return Promise.resolve()
  }
}

const PATH = 'path'
const TEXT = 'str'

describe('specWordKinds', () => {
  it('basic grep pattern and path', () => {
    expect(specWordKinds(specOf('grep'), ['pattern', 'file.txt'])).toEqual([TEXT, PATH])
  })

  it('TEXT flag values are positional', () => {
    expect(specWordKinds(specOf('find'), ['/data', '-name', '*.txt'])).toEqual([PATH, TEXT, TEXT])
  })

  it('--flag=value is not classified', () => {
    expect(specWordKinds(specOf('du'), ['--max-depth=1', '/data'])).toEqual([TEXT, PATH])
  })

  it('mixed cluster value is text, not path', () => {
    expect(specWordKinds(specOf('grep'), ['-ne', 'pat', '/a.txt'])).toEqual([TEXT, TEXT, PATH])
  })

  it('repeated -e values are text', () => {
    expect(specWordKinds(specOf('grep'), ['-e', 'foo', '-e', 'bar', '/a.txt'])).toEqual([
      TEXT,
      TEXT,
      TEXT,
      TEXT,
      PATH,
    ])
  })

  it('numeric shorthand is not a path', () => {
    expect(specWordKinds(specOf('head'), ['-5', 'file.txt'])).toEqual([TEXT, PATH])
  })

  // Expression syntax is TEXT, never left to the shape heuristic: the
  // rest slot's PATH kind read "(" as the bare path "/(", handing find a
  // phantom start point on top of the real one.
  it('find ignore tokens are TEXT', () => {
    const kinds = specWordKinds(specOf('find'), ['/data', '(', '-name', '*.txt', ')'])
    expect(kinds[0]).toBe(PATH)
    expect(kinds[1]).toBe(TEXT)
    expect(kinds[4]).toBe(TEXT)
  })

  it('bare ! is TEXT, in every position an expression can start', () => {
    expect(specWordKinds(specOf('find'), ['/data', '!', '-empty'])).toEqual([PATH, TEXT, TEXT])
    expect(specWordKinds(specOf('find'), ['/data', '-empty', '!', '-name', 'x'])).toEqual([
      PATH,
      TEXT,
      TEXT,
      TEXT,
      TEXT,
    ])
    expect(specWordKinds(specOf('find'), ['!', '-empty'])).toEqual([TEXT, TEXT])
  })

  // The override this replaced matched by value, so it re-nulled a `!`
  // sitting in an option's value slot as readily as a grammar token.
  it('! as a -name pattern keeps the TEXT of its slot', () => {
    expect(specWordKinds(specOf('find'), ['/data', '-name', '!'])).toEqual([PATH, TEXT, TEXT])
  })

  it('duplicate word gets TEXT and PATH by slot', () => {
    // F8: the same word is the pattern (TEXT) and a file glob (PATH);
    // value sets could not tell the two slots apart.
    expect(specWordKinds(specOf('grep'), ['*.txt', '*.txt'])).toEqual([TEXT, PATH])
  })

  // `-o/` is a well-formed first directory, so the shape heuristic took
  // each of these words for a path under the cwd.
  it('an attached path value is not a relative path', () => {
    expect(specWordKinds(specOf('sort'), ['-o/data/s1.txt', '/data/in.txt'])).toEqual([TEXT, PATH])
    expect(specWordKinds(specOf('grep'), ['-f/data/p.txt', '/data/in.txt'])).toEqual([TEXT, PATH])
    expect(specWordKinds(specOf('tar'), ['-cf/data/a.tar', 't'])).toEqual([TEXT, PATH])
  })
})

describe('an attached path value reaches the command', () => {
  it('sort -o/<path> writes the file', async () => {
    const { ws } = await makeIntegrationWS({ 'in.txt': 'b\na\n', 'sub/keep': '' })
    try {
      const [code, , err] = await runResult(ws, 'sort -o/data/s1.txt /data/in.txt')
      expect(err).toBe('')
      expect(code).toBe(0)
      expect(await run(ws, 'cat /data/s1.txt')).toBe('a\nb\n')
      expect(await run(ws, 'cd /data && sort -osub/s2.txt in.txt && cat sub/s2.txt')).toBe('a\nb\n')
    } finally {
      await ws.close()
    }
  })
})

describe('specForCommand', () => {
  it('falls back to the shared specs when the mount lacks the command', () => {
    const reg = new MountRegistry({ '/ram': new StubVFS() }, MountMode.WRITE)
    const mount = reg.mountFor('/ram')
    const name = Object.keys(BUILTIN_SPECS).find((n) => mount.specFor(n) === null)
    if (name === undefined) throw new Error('the mount serves every shared spec')
    expect(specForCommand(name, reg, '/ram')).toBe(BUILTIN_SPECS[name])
  })

  it('unknown name is null', () => {
    const reg = new MountRegistry({ '/ram': new StubVFS() }, MountMode.WRITE)
    expect(specForCommand('no-such-command', reg, '/ram')).toBeNull()
  })
})
