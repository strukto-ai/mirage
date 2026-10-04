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
import { IOResult } from '../../io/types.ts'
import { ExecutionNode } from '../../workspace/types.ts'
import { Channel, JobConsole, JobOutput } from '../console/index.ts'
import { JobTable } from './table.ts'
import type { JobResult } from './types.ts'
import { JobWaits } from './waits.ts'

describe('JobWaits', () => {
  it('join outlasts every job, including ones added meanwhile', async () => {
    const table = new JobTable()
    const waits = new JobWaits(new JobOutput(new JobConsole()))
    let open: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      open = resolve
    })
    const finished: string[] = []
    waits.add(
      table.submit({
        command: 'first',
        abort: new AbortController(),
        cwd: '/',
        run: () => {
          waits.add(
            table.submit({
              command: 'late',
              abort: new AbortController(),
              cwd: '/',
              run: async () => {
                await gate
                finished.push('late')
                return [new IOResult(), new ExecutionNode({ command: 'late' })] as JobResult
              },
            }),
          )
          finished.push('first')
          return Promise.resolve([
            new IOResult(),
            new ExecutionNode({ command: 'first' }),
          ] as JobResult)
        },
      }),
    )
    let joined = false
    const join = waits.join(new JobConsole()).then(() => {
      joined = true
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(joined).toBe(false)
    open()
    await join
    expect(finished).toEqual(['first', 'late'])
  })

  it('counts a job only through a stream the capture reads', () => {
    const capture = new JobOutput(new JobConsole())
    const waits = new JobWaits(capture)
    expect(waits.reaches(capture, new Set([Channel.STDOUT]))).toBe(true)
    expect(waits.reaches(capture, new Set([Channel.STDERR]))).toBe(false)
    expect(waits.reaches(new JobOutput(capture), new Set([Channel.STDOUT]))).toBe(true)
    expect(
      new JobWaits(capture, new Set([Channel.STDERR])).reaches(capture, new Set([Channel.STDERR])),
    ).toBe(true)
  })

  it('hands what the other jobs write on to the caller once it ends', async () => {
    const capture = new JobOutput(new JobConsole())
    const rest = new JobConsole()
    await new JobWaits(capture).join(rest)
    await capture.emit(Channel.STDERR, new TextEncoder().encode('late'))
    expect(new TextDecoder().decode(await rest.snapshot(Channel.STDERR))).toBe('late')
  })
})
