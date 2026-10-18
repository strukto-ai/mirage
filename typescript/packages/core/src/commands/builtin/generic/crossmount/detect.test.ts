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
import { PathSpec } from '../../../../types.ts'
import type { AggregateFn } from '../../../config.ts'
import {
  CROSS_MOUNT_COMMANDS,
  FANOUT_COMMANDS,
  RELAY_COMMANDS,
  STREAM_COMMANDS,
} from './constants.ts'
import { aggregateFor, isCrossMount, strategyFor } from './detect.ts'
import { Cmd, type OperandMount, Strategy } from './types.ts'

function on(
  virtual: string,
  mount: string | null,
  aggregate: AggregateFn | null = null,
  nests = false,
): OperandMount {
  return { path: PathSpec.fromStrPath(virtual), mount, aggregate, nests }
}

describe('strategyFor — mirrors tests/commands/builtin/generic/crossmount/test_detect.py', () => {
  it('assigns every command to exactly one strategy', () => {
    const names = [...STREAM_COMMANDS, ...FANOUT_COMMANDS, ...RELAY_COMMANDS]
    expect(new Set(names).size).toBe(names.length)
    for (const name of Object.values(Cmd)) expect(names).toContain(name)
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
  it('crosses when the operands span mounts', () => {
    const operands = [on('/a/x.txt', '/a/'), on('/b/y.txt', '/b/')]
    expect(isCrossMount('sort', operands)).toBe(true)
    expect(isCrossMount('sha256sum', operands)).toBe(true)
  })

  it('stays on one mount, for an unknown command, or with one operand', () => {
    expect(isCrossMount('sort', [on('/a/x.txt', '/a/'), on('/a/y.txt', '/a/')])).toBe(false)
    const spanning = [on('/a/x.txt', '/a/'), on('/b/y.txt', '/b/')]
    expect(isCrossMount('nocross', spanning)).toBe(false)
    expect(isCrossMount('sort', spanning.slice(0, 1))).toBe(false)
  })

  it('crosses nothing for an operand outside every mount', () => {
    expect(isCrossMount('sort', [on('/a/x.txt', '/a/'), on('/nowhere/y', null)])).toBe(false)
  })

  it('takes one shared reducer only', () => {
    const merge: AggregateFn = () => new Uint8Array()
    const other: AggregateFn = () => new Uint8Array()
    const both = [on('/a/x.txt', '/a/', merge), on('/b/y.txt', '/b/', merge)]
    expect(aggregateFor('custom', both)).toBe(merge)
    expect(isCrossMount('custom', both)).toBe(true)
    expect(
      aggregateFor('custom', [on('/a/x.txt', '/a/', merge), on('/b/y.txt', '/b/', other)]),
    ).toBeNull()
    expect(aggregateFor('custom', [on('/a/x.txt', '/a/', merge), on('/b/y.txt', '/b/')])).toBeNull()
    expect(aggregateFor('sort', both)).toBeNull()
  })

  it('crosses cp for a source holding a mount, not the destination', () => {
    const tree = on('/a/d', '/a/', null, true)
    const file = on('/a/f.txt', '/a/')
    const into = on('/a/e', '/a/')
    expect(isCrossMount('cp', [tree, into])).toBe(true)
    expect(isCrossMount('cp', [file, tree])).toBe(false)
    expect(isCrossMount('cp', [into, tree], [into.path])).toBe(true)
    expect(isCrossMount('cp', [tree, file], [tree.path])).toBe(false)
  })
})
