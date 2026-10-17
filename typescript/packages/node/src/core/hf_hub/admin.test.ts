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
import { HfAccountAccessor } from '../../accessor/hf_hub.ts'
import { createRepo, createTag, deleteTag, splitRepoId } from './admin.ts'
import * as client from './client.ts'
import { API_BASE } from './constants.ts'

const ACCOUNT = new HfAccountAccessor({ token: 't', endpoint: API_BASE })

describe('splitRepoId', () => {
  it('takes the two halves apart', () => {
    // The create and delete endpoints do not take a namespace/name id; they
    // take the two separately, and a bare name means your own namespace.
    expect(splitRepoId('acme/widget')).toEqual(['acme', 'widget'])
    expect(splitRepoId('widget')).toEqual([null, 'widget'])
  })
})

describe('createRepo', () => {
  it('sends name, organization and type', async () => {
    const post = vi.spyOn(client, 'hubPost').mockResolvedValue({ url: 'https://hf.co/acme/widget' })
    await createRepo(ACCOUNT, 'acme/widget', { repoType: 'dataset' })
    expect(String(post.mock.calls[0]?.[1])).toMatch(/\/api\/repos\/create$/)
    expect(post.mock.calls[0]?.[2]).toEqual({
      name: 'widget',
      organization: 'acme',
      type: 'dataset',
    })
    post.mockRestore()
  })

  it('marks visibility only when private', async () => {
    const post = vi.spyOn(client, 'hubPost').mockResolvedValue({})
    await createRepo(ACCOUNT, 'a/b', { private: true })
    expect((post.mock.calls[0]?.[2] as Record<string, unknown>).visibility).toBe('private')
    post.mockRestore()
  })

  it('carries a space sdk', async () => {
    const post = vi.spyOn(client, 'hubPost').mockResolvedValue({})
    await createRepo(ACCOUNT, 'a/b', { repoType: 'space', spaceSdk: 'gradio' })
    expect((post.mock.calls[0]?.[2] as Record<string, unknown>).sdk).toBe('gradio')
    post.mockRestore()
  })
})

describe('tags', () => {
  it('targets the revision when creating', async () => {
    const post = vi.spyOn(client, 'hubPost').mockResolvedValue({})
    await createTag(ACCOUNT, 'a/b', 'v1', 'model', 'abc123', 'note')
    expect(String(post.mock.calls[0]?.[1])).toMatch(/\/tag\/abc123$/)
    expect(post.mock.calls[0]?.[2]).toEqual({ tag: 'v1', message: 'note' })
    post.mockRestore()
  })

  it('deletes by tag name', async () => {
    const req = vi.spyOn(client, 'hubRequest').mockResolvedValue(undefined as never)
    await deleteTag(ACCOUNT, 'a/b', 'v1')
    expect(req.mock.calls[0]?.[1]).toBe('DELETE')
    expect(String(req.mock.calls[0]?.[2])).toMatch(/\/tag\/v1$/)
    req.mockRestore()
  })
})

describe('revisions holding a slash', () => {
  it('encodes the revision a tag is created on', async () => {
    const post = vi.spyOn(client, 'hubPost').mockResolvedValue({})
    await createTag(ACCOUNT, 'a/b', 'v1', 'model', 'feature/foo')
    expect(String(post.mock.calls[0]?.[1])).toMatch(/\/tag\/feature%2Ffoo$/)
    post.mockRestore()
  })

  it('encodes the tag being deleted', async () => {
    const req = vi.spyOn(client, 'hubRequest').mockResolvedValue(undefined as never)
    await deleteTag(ACCOUNT, 'a/b', 'release/v1')
    expect(String(req.mock.calls[0]?.[2])).toMatch(/\/tag\/release%2Fv1$/)
    req.mockRestore()
  })
})
