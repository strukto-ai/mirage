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
import { Runtime } from './base.ts'

class SlowCloseRuntime extends Runtime<object> {
  readonly name = 'slow-close'
  closed = 0
  release!: () => void
  readonly entered: Promise<void>
  private markEntered!: () => void

  constructor() {
    super()
    this.entered = new Promise((resolve) => {
      this.markEntered = resolve
    })
  }

  protected override openEngine(): Promise<object> {
    return Promise.resolve({})
  }

  protected override async closeEngine(_engine: object): Promise<void> {
    this.markEntered()
    await new Promise<void>((resolve) => {
      this.release = resolve
    })
    this.closed += 1
  }
}

describe('Runtime.close', () => {
  it('a second close waits for the engine the first is closing', async () => {
    const rt = new SlowCloseRuntime()
    await rt.engine()
    const first = rt.close()
    await rt.entered
    let secondDone = false
    const second = rt.close().then(() => {
      secondDone = true
    })
    await Promise.resolve()
    expect(secondDone).toBe(false)
    rt.release()
    await Promise.all([first, second])
    expect(rt.closed).toBe(1)
  })
})
