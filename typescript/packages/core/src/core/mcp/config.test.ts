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
import { z } from 'zod'
import { parseConfigWithSchema, REDACTED_SECRET, redactedConfigDump } from '../../vfs/secrets.ts'
import { MCPAuth, MCPConfig } from './config.ts'

describe('MCPConfig', () => {
  it('takes no auth', () => {
    expect(parseConfigWithSchema(MCPConfig, { url: 'http://x/mcp' }).auth).toBeUndefined()
  })

  it('reads the nulls a Python snapshot writes', () => {
    expect(parseConfigWithSchema(MCPConfig, { url: 'http://x/mcp', auth: null }).auth).toBeNull()
    const auth = { type: 'bearer', token: 't', name: null }
    expect(parseConfigWithSchema(MCPConfig, { url: 'http://x/mcp', auth }).auth).toEqual(auth)
  })

  it.each([
    { type: 'header', token: 't' },
    { type: 'bearer', token: 't', name: 'x-api-key' },
    { type: 'header', name: 'x-api-key:', token: 't' },
    { type: 'header', name: 'x\r\nevil: 1', token: 't' },
    { type: 'basic', token: 't' },
    { type: 'bearer', token: 't', extra: 1 },
  ])('refuses an auth block that cannot build one header: %j', (auth) => {
    expect(() => parseConfigWithSchema(MCPConfig, { url: 'http://x/mcp', auth })).toThrow(
      z.ZodError,
    )
  })

  it.each(['', 's3cr3t\n', 's3cr3t\u0000', ' s3cr3t', 's3cr3t ', 's3cr3t\u007f', 'sécret'])(
    'refuses a token no header can carry: %j',
    (token) => {
      const auth = { type: 'bearer', token }
      expect(() => parseConfigWithSchema(MCPConfig, { url: 'http://x/mcp', auth })).toThrow(
        z.ZodError,
      )
    },
  )

  it('never prints a refused token', () => {
    const auth = { type: 'bearer', token: 's3cr3t\n' }
    expect(() => parseConfigWithSchema(MCPConfig, { url: 'http://x/mcp', auth })).toThrow(
      /^(?![\s\S]*s3cr3t)/,
    )
  })

  it('takes a token with a space inside', () => {
    const auth = { type: 'bearer', token: 'a b' }
    expect(parseConfigWithSchema(MCPConfig, { url: 'http://x/mcp', auth }).auth?.token).toBe('a b')
  })

  it('stays objects the redaction walk reaches', () => {
    expect(MCPConfig).toBeInstanceOf(z.ZodObject)
    expect(MCPAuth).toBeInstanceOf(z.ZodObject)
    const config = { url: 'http://x/mcp', auth: { type: 'header', name: 'x-api-key', token: 's' } }
    expect(redactedConfigDump(MCPConfig, config)).toEqual({
      url: 'http://x/mcp',
      auth: { type: 'header', name: 'x-api-key', token: REDACTED_SECRET },
    })
  })
})
