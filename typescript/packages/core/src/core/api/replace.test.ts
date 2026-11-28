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

import { describe, expect, it, vi } from 'vitest'
import { ApiError } from './errors.ts'
import { asideName, landThenRetire, setAside } from './replace.ts'

// Each step records its name, and fails when told to.
class Steps {
  readonly done: string[] = []
  gone: boolean | Error = false
  found: string | null = null

  constructor(private readonly failing: Record<string, Error> = {}) {}

  step(name: string): Promise<string> {
    this.done.push(name)
    const failure = this.failing[name]
    return failure === undefined ? Promise.resolve(name) : Promise.reject(failure)
  }

  isGone(): Promise<boolean> {
    this.done.push('gone?')
    const gone = this.gone
    return gone instanceof Error ? Promise.reject(gone) : Promise.resolve(gone)
  }

  arrived(): Promise<string | null> {
    this.done.push('arrived?')
    return Promise.resolve(this.found)
  }
}

function replaced(steps: Steps, restore = true): Promise<string> {
  return landThenRetire(
    () => steps.step('land'),
    (landed) => steps.step(`take back ${landed}`),
    () => steps.step('retire'),
    () => steps.isGone(),
    restore ? () => steps.step('restore') : undefined,
    () => steps.arrived(),
  )
}

describe('replace', () => {
  it('draws a fresh name beside the name', () => {
    const first = asideName('b.txt')
    expect(first).toMatch(/^b\.txt\.mirage-[0-9a-f]{32}$/)
    expect(asideName('b.txt')).not.toBe(first)
  })

  it('puts nothing back after a refused set-aside, which moved nothing', async () => {
    const steps = new Steps({ aside: new ApiError('denied', 403) })
    await expect(
      setAside(
        () => steps.step('aside'),
        () => steps.step('restore'),
      ),
    ).rejects.toBeInstanceOf(ApiError)
    expect(steps.done).toEqual(['aside'])
  })

  it.each([
    ['dropped', new TypeError('fetch failed')],
    ['5xx', new ApiError('bad gateway', 502)],
    // A retried 503 answers with what its retry met, after the first attempt
    // moved the item.
    ['retried', new ApiError('not found', 404)],
  ])('puts back a set-aside whose answer was lost (%s)', async (_kind, failure) => {
    // The move may have gone through, so the name is put back; the error that
    // called for it stays the one thrown.
    const steps = new Steps({ aside: failure })
    await expect(
      setAside(
        () => steps.step('aside'),
        () => steps.step('restore'),
      ),
    ).rejects.toBe(failure)
    expect(steps.done).toEqual(['aside', 'restore'])
  })

  it('lands then retires', async () => {
    const steps = new Steps()
    expect(await replaced(steps)).toBe('land')
    expect(steps.done).toEqual(['land', 'retire'])
  })

  it('restores what was set aside when the landing is refused', async () => {
    const steps = new Steps({ land: new ApiError('denied', 403) })
    await expect(replaced(steps)).rejects.toBeInstanceOf(ApiError)
    expect(steps.done).toEqual(['land', 'restore'])
  })

  it('takes the landing back, then restores, when the retire is refused', async () => {
    // The landing goes first, so the name is free for what was set aside.
    const steps = new Steps({ retire: new ApiError('denied', 403) })
    await expect(replaced(steps)).rejects.toBeInstanceOf(ApiError)
    expect(steps.done).toEqual(['land', 'retire', 'gone?', 'take back land', 'restore'])
  })

  it('only takes the landing back when nothing was set aside', async () => {
    const steps = new Steps({ retire: new ApiError('denied', 403) })
    await expect(replaced(steps, false)).rejects.toBeInstanceOf(ApiError)
    expect(steps.done).toEqual(['land', 'retire', 'gone?', 'take back land'])
  })

  it('keeps the replace when the retire went through', async () => {
    // A delete whose answer was lost: what it named is gone, so undoing the
    // landing would leave nothing at the name.
    const steps = new Steps({ retire: new TypeError('fetch failed') })
    steps.gone = true
    expect(await replaced(steps)).toBe('land')
    expect(steps.done).toEqual(['land', 'retire', 'gone?'])
  })

  it('finishes a lost landing that went through', async () => {
    // The landing holds the name, where nothing can be put back: what it made
    // is found and the replace goes on to the retire.
    const steps = new Steps({ land: new TypeError('fetch failed') })
    steps.found = 'found'
    expect(await replaced(steps)).toBe('found')
    expect(steps.done).toEqual(['land', 'arrived?', 'retire'])
  })

  it('restores after a lost landing that did not land', async () => {
    const steps = new Steps({ land: new ApiError('bad gateway', 502) })
    await expect(replaced(steps)).rejects.toBeInstanceOf(ApiError)
    expect(steps.done).toEqual(['land', 'arrived?', 'restore'])
  })

  it('asks nothing after a refused landing', async () => {
    // A 4xx means nothing landed, so the service is not asked.
    const steps = new Steps({ land: new ApiError('denied', 403) })
    steps.found = 'found'
    await expect(replaced(steps)).rejects.toBeInstanceOf(ApiError)
    expect(steps.done).toEqual(['land', 'restore'])
  })

  it('keeps the landing when the retire cannot be told', async () => {
    // The delete may have gone through: undoing the landing then would leave
    // nothing at the name, so the landing stays and the error is thrown.
    const failure = new TypeError('fetch failed')
    const steps = new Steps({ retire: failure })
    steps.gone = new TypeError('still failing')
    await expect(replaced(steps)).rejects.toBe(failure)
    expect(steps.done).toEqual(['land', 'retire', 'gone?'])
  })

  it('keeps the error that called for a failed undo', async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    const refusal = new ApiError('denied', 403)
    const steps = new Steps({ retire: refusal, 'take back land': new ApiError('also', 403) })
    await expect(replaced(steps)).rejects.toBe(refusal)
    expect(steps.done.at(-1)).toBe('restore')
  })
})
