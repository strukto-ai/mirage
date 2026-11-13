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
import { Channel, JobConsole, JobOutput } from '../../shell/console/index.ts'
import { JobTable } from './table.ts'
import type { JobResult } from './handle.ts'
import { Hold, JobWaits } from './waits.ts'

describe('JobWaits', () => {
  it('join outlasts every job, including ones added meanwhile', async () => {
    const table = new JobTable()
    const waits = new JobWaits(new JobOutput(new JobConsole()))
    let open: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      open = resolve
    })
    const finished: string[] = []
    const first = await table.submit({
      command: 'first',
      abort: new AbortController(),
      cwd: '/',
      run: async () => {
        const late = await table.submit({
          command: 'late',
          abort: new AbortController(),
          cwd: '/',
          run: async () => {
            await gate
            finished.push('late')
            return [new IOResult(), new ExecutionNode({ command: 'late' })] as JobResult
          },
        })
        waits.add(() => late.console.waitFinished(), new Set(['&1']))
        finished.push('first')
        return [new IOResult(), new ExecutionNode({ command: 'first' })] as JobResult
      },
    })
    waits.add(() => first.console.waitFinished(), new Set(['&1']))
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

  it('lets go of a child that closed what led into it', async () => {
    const waits = new JobWaits(new JobOutput(new JobConsole()))
    const hold = waits.add(() => new Promise<void>(() => undefined), new Set(['&1']))
    let joined = false
    const join = waits.join(new JobConsole()).then(() => {
      joined = true
    })
    hold.settle(new Set(['&1', '&2']))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(joined).toBe(false)
    hold.settle(new Set(['/dev/null', '&2']))
    await join
  })

  it('keeps a hold while a copy still names the stream', async () => {
    const hold = new Hold(new Set(['&1']))
    hold.settle(new Set(['/dev/null', '&2', '&1']))
    const released = await Promise.race([
      hold.released.then(() => true),
      new Promise<boolean>((resolve) =>
        setTimeout(() => {
          resolve(false)
        }, 10),
      ),
    ])
    expect(released).toBe(false)
  })

  it('fails the join when waiting for a child fails', async () => {
    const waits = new JobWaits(new JobOutput(new JobConsole()))
    waits.add(() => Promise.reject(new Error('store lost')), new Set(['&1']))
    await expect(waits.join(new JobConsole())).rejects.toThrow('store lost')
  })

  it('hands what the other jobs write on to the caller once it ends', async () => {
    const capture = new JobOutput(new JobConsole())
    const rest = new JobConsole()
    await new JobWaits(capture).join(rest)
    await capture.emit(Channel.STDERR, new TextEncoder().encode('late'))
    expect(new TextDecoder().decode(await rest.snapshot(Channel.STDERR))).toBe('late')
  })
})
