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

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabricksVolume, DIRS, FILES, ROOT } from '../../../tests/fixtures/databricks_volume.ts'
import { serve } from '../../../tests/fixtures/kit_fake.ts'
import { MountMode } from '../../types.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'
import { DatabricksVolumeVFS } from './databricks_volume.ts'

const FROZEN_NOW_S = 1_700_000_000
const DAY_S = 86_400
const AGES_DAYS = [1, 2, 3, 10, 20]

let origin = ''
let volume: DatabricksVolume

beforeAll(async () => {
  origin = await serve('databricks')
})

beforeEach(async () => {
  volume = new DatabricksVolume(origin)
  await volume.reset()
})

afterEach(async () => {
  vi.useRealTimers()
  await volume.run.close()
})

async function seedFlat(count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await volume.put(`${ROOT}/sub/f${String(i)}.txt`, 'x'.repeat(i + 1))
  }
}

async function seedNested(): Promise<void> {
  await volume.put(`${ROOT}/sub/a.txt`, 'a')
  await volume.put(`${ROOT}/sub/inner/b.txt`, 'bb')
}

// Runs one line over a fresh mount, the way the agent's shell does.
async function run(line: string): Promise<string[]> {
  const ws = new Workspace(
    { '/volume': new DatabricksVolumeVFS({ accessor: volume.accessor() }) },
    { mode: MountMode.READ },
  )
  try {
    const result = await ws.shell(line)
    expect([result.exitCode, result.stderrText], line).toEqual([0, ''])
    return result.stdoutText.split('\n').filter((l) => l !== '')
  } finally {
    await ws.close()
  }
}

const listings = (): Promise<string[]> => volume.asked('GET', DIRS)

// The operand's own stat may ask; a child's never does.
async function childStats(): Promise<string[]> {
  const asked = [...(await volume.asked('HEAD', FILES)), ...(await volume.asked('HEAD', DIRS))]
  return asked.filter((path) => path.includes('/sub/'))
}

describe('databricks_volume listing API-call counts', () => {
  it.each(['', '-l', '-t', '-S'])('ls %s lists once and never stats entries', async (flags) => {
    await seedFlat(5)
    await volume.run.recordRequests()
    await run(`ls ${flags} /volume/sub`)
    expect(await listings()).toHaveLength(1)
    expect(await childStats()).toHaveLength(0)
  })

  it('tree lists one directory per level and never stats entries', async () => {
    await seedNested()
    await volume.run.recordRequests()
    await run('tree /volume/sub')
    expect(await listings()).toHaveLength(2)
    expect(await childStats()).toHaveLength(0)
  })

  it.each(['-type f', '-size +3c', '-mtime -100000'])(
    'find %s lists once and never stats children',
    async (texts) => {
      await seedFlat(5)
      await volume.run.recordRequests()
      await run(`find /volume/sub ${texts}`)
      expect(await listings()).toHaveLength(1)
      expect(await childStats()).toHaveLength(0)
    },
  )

  it('find -mtime filters on the modified time the listing names', async () => {
    for (const [i, age] of AGES_DAYS.entries()) {
      await volume.put(`${ROOT}/sub/f${String(i)}.txt`, 'x'.repeat(i + 1))
      await volume.setModified(`${ROOT}/sub/f${String(i)}.txt`, (FROZEN_NOW_S - age * DAY_S) * 1000)
    }
    await volume.run.recordRequests()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(FROZEN_NOW_S * 1000)
    const names = (await run('find /volume/sub -mtime -5'))
      .filter((line) => line.endsWith('.txt'))
      .map((line) => line.split('/').pop())
      .sort()
    vi.useRealTimers()
    expect(names).toEqual(['f0.txt', 'f1.txt', 'f2.txt'])
    expect(await listings()).toHaveLength(1)
    expect(await childStats()).toHaveLength(0)
  })
})
