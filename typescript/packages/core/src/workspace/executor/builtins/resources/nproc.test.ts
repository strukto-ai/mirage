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
import {
  decoded,
  resources,
  tableOf,
} from '../../../../../tests/workspace/fixtures/machine_resources.ts'
import { handleNproc } from './nproc.ts'

describe('nproc', () => {
  it('puts the workspace first with one processor', async () => {
    const [out, io] = await handleNproc(tableOf([resources()]), ['nproc'])
    expect([decoded(out), io.exitCode]).toEqual(['1  mirage\n4  docker:a\n', 0])
  })

  it('never adds several machines up', async () => {
    const table = tableOf([resources('docker:a', { cpus: 14 }), resources('e2b:b', { cpus: 2 })])
    expect(decoded((await handleNproc(table, ['nproc']))[0])).toBe(
      ' 1  mirage\n14  docker:a\n 2  e2b:b\n',
    )
  })

  it('applies --all and --ignore to each machine', async () => {
    const [out] = await handleNproc(tableOf([resources()]), ['nproc', '--all', '--ignore=3'])
    expect(decoded(out)).toBe('1  mirage\n5  docker:a\n')
  })

  it('picks one with --machine', async () => {
    const table = tableOf([resources('docker:a'), resources('e2b:b', { cpus: 2 })])
    expect(decoded((await handleNproc(table, ['nproc', '--machine', 'e2b:b']))[0])).toBe('2\n')
  })

  it('picks the workspace with --machine', async () => {
    const [out] = await handleNproc(tableOf([resources()]), ['nproc', '--machine', 'mirage'])
    expect(decoded(out)).toBe('1\n')
  })

  it('refuses a bad ignore', async () => {
    const [, io] = await handleNproc(tableOf([resources()]), ['nproc', '--ignore=x'])
    expect([decoded(io.stderr), io.exitCode]).toEqual(["nproc: invalid number: 'x'\n", 1])
  })

  it('refuses an unknown machine', async () => {
    const [, io] = await handleNproc(tableOf([resources()]), ['nproc', '--machine', 'nosuch'])
    expect([decoded(io.stderr), io.exitCode]).toEqual(['nproc: nosuch: no such machine\n', 1])
  })
})
