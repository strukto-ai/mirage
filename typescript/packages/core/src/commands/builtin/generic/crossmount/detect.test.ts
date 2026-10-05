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
import { MountMode, PathSpec } from '../../../../types.ts'
import { RAMVFS } from '../../../../vfs/ram/ram.ts'
import { MountRegistry } from '../../../../workspace/mount/registry.ts'
import {
  CROSS_MOUNT_COMMANDS,
  FANOUT_COMMANDS,
  RELAY_COMMANDS,
  STREAM_COMMANDS,
} from './constants.ts'
import { isCrossMount, strategyFor } from './detect.ts'
import { Cmd, Strategy } from './types.ts'

describe('strategyFor — mirrors tests/commands/builtin/generic/crossmount/test_detect.py', () => {
  it('assigns every command to exactly one strategy', () => {
    const names = [...STREAM_COMMANDS, ...FANOUT_COMMANDS, ...RELAY_COMMANDS]
    expect(new Set(names).size).toBe(names.length)
    expect(new Set(names)).toEqual(new Set(Object.values(Cmd)))
    expect(CROSS_MOUNT_COMMANDS).toEqual(new Set(names))
  })

  it('rejects unregistered commands', () => {
    expect(() => strategyFor('unknown')).toThrow('Unsupported cross-mount command: unknown')
  })

  it.each([
    [Strategy.STREAM, [Cmd.CAT, Cmd.NL, Cmd.CUT]],
    [Strategy.FANOUT, [Cmd.HEAD, Cmd.SHA256SUM, Cmd.RM, Cmd.REV]],
    [
      Strategy.RELAY,
      [
        Cmd.CP,
        Cmd.MV,
        Cmd.TEE,
        Cmd.DIFF,
        Cmd.CMP,
        Cmd.SORT,
        Cmd.WC,
        Cmd.GREP,
        Cmd.RG,
        Cmd.REALPATH,
        Cmd.AWK,
        Cmd.LS,
        Cmd.SED,
      ],
    ],
  ])('routes to %s', (strategy, names) => {
    for (const name of names) {
      expect(strategyFor(name)).toBe(strategy)
    }
  })
})

describe('isCrossMount — mirrors tests/commands/builtin/generic/crossmount/test_detect.py', () => {
  it('crosses cp for a source holding a mount, not the destination', () => {
    const registry = new MountRegistry(
      { '/a': new RAMVFS(), '/a/d/n': new RAMVFS() },
      MountMode.WRITE,
    )
    const tree = PathSpec.fromStrPath('/a/d')
    const file = PathSpec.fromStrPath('/a/f.txt')
    const into = PathSpec.fromStrPath('/a/e')
    expect(isCrossMount('cp', [tree, into], registry)).toBe(true)
    expect(isCrossMount('cp', [file, tree], registry)).toBe(false)
    expect(isCrossMount('cp', [into, tree], registry, [into])).toBe(true)
    expect(isCrossMount('cp', [tree, file], registry, [tree])).toBe(false)
  })
})
