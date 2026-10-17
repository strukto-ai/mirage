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

import { materialize } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import { mountKey } from '../../../utils/key_prefix.ts'
import type { Context } from '../../config.ts'
import type { FlagValue } from '../../spec/types.ts'
import { readlinkGeneric } from './readlink.ts'

const DEC = new TextDecoder()

function spec(original: string, prefix = ''): PathSpec {
  return new PathSpec({
    vfsPath: mountKey(original, prefix),
    virtual: original,
    directory: original,
    resolved: true,
  })
}

async function readlink(paths: PathSpec[], flags: Record<string, FlagValue> = {}): Promise<string> {
  const [out] = readlinkGeneric(paths, [], { flags } as unknown as Context) ?? [null]
  return DEC.decode(await materialize(out))
}

// Mirrors python's tests/commands/builtin/generic/test_readlink.py.
describe('readlinkGeneric', () => {
  it('prints the operand', async () => {
    expect(await readlink([spec('/a/b')])).toBe('/a/b\n')
  })

  it('prints a path on a mount once, not under its prefix again', async () => {
    // GNU readlink -f /data/x prints /data/x (debian:stable-slim); this
    // printed the mount prefix twice, /data/data/x.
    expect(await readlink([spec('/mnt/b', '/mnt')])).toBe('/mnt/b\n')
    expect(await readlink([spec('/data/x', '/data')], { canonicalize: true })).toBe('/data/x\n')
  })

  it('normalizes under -f', async () => {
    expect(await readlink([spec('/a/./b')], { canonicalize: true })).toBe('/a/b\n')
    expect(await readlink([spec('/data/sub/../x', '/data')], { canonicalize: true })).toBe(
      '/data/x\n',
    )
  })

  it('leaves the newline off under -n', async () => {
    expect(await readlink([spec('/data/x', '/data')], { no_newline: true })).toBe('/data/x')
  })

  it('refuses a missing operand', () => {
    expect(() => readlinkGeneric([], [], { flags: {} } as unknown as Context)).toThrow(
      /missing operand/,
    )
  })
})
