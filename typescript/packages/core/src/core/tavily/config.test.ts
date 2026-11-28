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
import { parseConfigWithSchema, redactedConfigDump } from '../../vfs/secrets.ts'
import { TavilyConfig } from './config.ts'

// Mirrors python's tests/core/tavily/test_config.py.
describe('tavily config', () => {
  it('leaves the key unset and the defaults to the client', () => {
    const config = parseConfigWithSchema(TavilyConfig, {})
    expect(config.apiKey).toBeUndefined()
    expect(config.baseUrl).toBeUndefined()
    expect(config.timeout).toBeUndefined()
  })

  it('fails loud on an unknown field', () => {
    expect(() => parseConfigWithSchema(TavilyConfig, { api_kye: 'tvly-k' })).toThrow()
  })

  it('never prints the key in a dump', () => {
    const config = parseConfigWithSchema(TavilyConfig, { api_key: 'tvly-secret' })
    expect(JSON.stringify(redactedConfigDump(TavilyConfig, config))).not.toContain('tvly-secret')
  })
})
