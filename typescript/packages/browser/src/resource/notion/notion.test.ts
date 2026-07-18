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

import {
  MemoryOAuthClientProvider,
  NOTION_COMMANDS,
  NOTION_OPS,
  ResourceName,
} from '@struktoai/mirage-core'
import type { OAuthClientMetadata } from '@modelcontextprotocol/sdk/shared/auth.js'
import { describe, expect, it } from 'vitest'
import { NotionResource } from './notion.ts'

const clientMetadata: OAuthClientMetadata = {
  redirect_uris: ['https://example.com/callback'],
  client_name: 'mirage-notion-test',
}

function makeAuthProvider(): MemoryOAuthClientProvider {
  return new MemoryOAuthClientProvider({
    clientMetadata,
    redirect: (_url: URL): void => undefined,
  })
}

describe('NotionResource (browser)', () => {
  it('constructs with authProvider and exposes expected fields', () => {
    const authProvider = makeAuthProvider()
    const r = new NotionResource({ authProvider })
    expect(r.kind).toBe(ResourceName.NOTION)
    expect(r.cachesReads).toBe(true)
    expect(r.indexTtl).toBe(600)
    expect(r.config).toEqual({ authProvider })
    expect(typeof r.prompt).toBe('string')
    expect(r.prompt.length).toBeGreaterThan(0)
    expect(typeof r.writePrompt).toBe('string')
    expect(r.writePrompt.length).toBeGreaterThan(0)
  })

  it('commands() returns NOTION_COMMANDS', () => {
    const r = new NotionResource({ authProvider: makeAuthProvider() })
    expect(r.commands()).toBe(NOTION_COMMANDS)
  })

  it('ops() returns NOTION_OPS', () => {
    const r = new NotionResource({ authProvider: makeAuthProvider() })
    expect(r.ops()).toBe(NOTION_OPS)
  })

  it('getState() returns redacted config for default config', async () => {
    const r = new NotionResource({ authProvider: makeAuthProvider() })
    const state = await r.getState()
    expect(state.type).toBe(ResourceName.NOTION)
    expect(state).not.toHaveProperty('needsOverride')
    expect(state).not.toHaveProperty('redactedFields')
    expect(state.config).toEqual({ authProvider: '<REDACTED>' })
  })

  it('getState() includes serverUrl when provided', async () => {
    const r = new NotionResource({
      authProvider: makeAuthProvider(),
      serverUrl: 'https://mcp.example.com/mcp',
    })
    const state = await r.getState()
    expect(state.config).toEqual({
      authProvider: '<REDACTED>',
      serverUrl: 'https://mcp.example.com/mcp',
    })
  })
})
