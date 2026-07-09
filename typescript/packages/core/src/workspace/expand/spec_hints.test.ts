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
import { OperandKind } from '../../commands/spec/types.ts'
import type { Resource } from '../../resource/base.ts'
import { MountMode } from '../../types.ts'
import { MountRegistry } from '../mount/registry.ts'
import { specForCommand, specWordKinds } from './spec_hints.ts'

class StubResource implements Resource {
  readonly kind = 'stub'
  open(): Promise<void> {
    return Promise.resolve()
  }
  close(): Promise<void> {
    return Promise.resolve()
  }
}

const PATH = OperandKind.PATH
const TEXT = OperandKind.TEXT

describe('specWordKinds', () => {
  it('basic grep pattern and path', () => {
    expect(specWordKinds(specOf('grep'), ['pattern', 'file.txt'])).toEqual([TEXT, PATH])
  })

  it('TEXT flag values are positional', () => {
    expect(specWordKinds(specOf('find'), ['/data', '-name', '*.txt'])).toEqual([PATH, null, TEXT])
  })

  it('--flag=value is not classified', () => {
    expect(specWordKinds(specOf('du'), ['--max-depth=1', '/data'])).toEqual([null, PATH])
  })

  it('mixed cluster value is text, not path', () => {
    expect(specWordKinds(specOf('grep'), ['-ne', 'pat', '/a.txt'])).toEqual([null, TEXT, PATH])
  })

  it('repeated -e values are text', () => {
    expect(specWordKinds(specOf('grep'), ['-e', 'foo', '-e', 'bar', '/a.txt'])).toEqual([
      null,
      TEXT,
      null,
      TEXT,
      PATH,
    ])
  })

  it('numeric shorthand is not a path', () => {
    expect(specWordKinds(specOf('head'), ['-5', 'file.txt'])).toEqual([null, PATH])
  })

  it('find ignore tokens are not classified', () => {
    const kinds = specWordKinds(specOf('find'), ['/data', '(', '-name', '*.txt', ')'])
    expect(kinds[0]).toBe(PATH)
    expect(kinds[1]).toBeNull()
    expect(kinds[4]).toBeNull()
  })

  it('duplicate word gets TEXT and PATH by slot', () => {
    // F8: the same word is the pattern (TEXT) and a file glob (PATH);
    // value sets could not tell the two slots apart.
    expect(specWordKinds(specOf('grep'), ['*.txt', '*.txt'])).toEqual([TEXT, PATH])
  })
})

describe('specForCommand', () => {
  it('falls back to the shared specs when the mount lacks the command', () => {
    const reg = new MountRegistry({ '/ram': new StubResource() }, MountMode.WRITE)
    expect(specForCommand('grep', reg, '/ram')).toBe(BUILTIN_SPECS.grep)
  })

  it('unknown name is null', () => {
    const reg = new MountRegistry({ '/ram': new StubResource() }, MountMode.WRITE)
    expect(specForCommand('no-such-command', reg, '/ram')).toBeNull()
  })
})
