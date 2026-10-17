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
import * as client from './client.ts'
import { handle } from './_test_util.ts'
import { classifyAbsence, headCommit, revisionUrl } from './repo.ts'

describe('headCommit', () => {
  it('reads the sha', async () => {
    const spy = vi.spyOn(client, 'hubGet').mockResolvedValue({ sha: 'deadbeef' })
    expect(await headCommit(handle())).toBe('deadbeef')
    spy.mockRestore()
  })

  it('asks the revision, not the bare repo', async () => {
    // The bare repo object answers the default branch's sha whatever
    // revision was asked for, and the download cache is keyed by this sha,
    // so reading it there files a `--revision dev` fetch under main's
    // snapshot and points refs/dev at it.
    const spy = vi.spyOn(client, 'hubGet').mockResolvedValue({ sha: 'deadbeef' })
    await headCommit(handle({ revision: 'dev' }))
    expect(String(spy.mock.calls[0]?.[1])).toMatch(/\/revision\/dev$/)
    spy.mockRestore()
  })

  // The head is asked trimmed to its sha, as a query param; the url itself is
  // the one every not-found message names, so it carries no query.
  it('asks only for the sha', async () => {
    const spy = vi.spyOn(client, 'hubGet').mockResolvedValue({ sha: 'deadbeef' })
    const acc = handle()
    await headCommit(acc)
    expect(spy.mock.calls[0]?.[1]).toBe(revisionUrl(acc))
    expect(spy.mock.calls[0]?.[2]).toEqual({ 'expand[]': 'sha' })
    spy.mockRestore()
  })

  it('is empty when the Hub reports none', async () => {
    const spy = vi.spyOn(client, 'hubGet').mockResolvedValue({})
    expect(await headCommit(handle())).toBe('')
    spy.mockRestore()
  })

  it('is empty when the Hub answered something that is not an object', async () => {
    const spy = vi.spyOn(client, 'hubGet').mockResolvedValue([])
    expect(await headCommit(handle())).toBe('')
    spy.mockRestore()
  })
})

describe('revisionUrl', () => {
  it('encodes a revision holding a slash', () => {
    expect(revisionUrl(handle({ revision: 'feature/foo' }))).toMatch(/\/revision\/feature%2Ffoo$/)
  })
})

describe('classifyAbsence', () => {
  it('asks the bare revision url', async () => {
    const spy = vi.spyOn(client, 'hubGet').mockResolvedValue({})
    const acc = handle()
    await classifyAbsence(acc)
    expect(spy.mock.calls[0]?.[1]).toBe(revisionUrl(acc))
    expect(revisionUrl(acc)).not.toContain('?')
    expect(spy.mock.calls[0]?.[2]).toBeUndefined()
    spy.mockRestore()
  })
})
