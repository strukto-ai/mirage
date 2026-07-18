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
import { renderHelp } from './help.ts'
import { CommandSpec, OperandKind, Option } from './types.ts'

describe('renderHelp', () => {
  it('renders name, description, usage, and flag table', () => {
    const spec = new CommandSpec({
      description: 'Send a thing.',
      options: [
        new Option({ long: '--to', valueKind: OperandKind.TEXT, description: 'Recipient' }),
        new Option({ long: '--help', valueKind: OperandKind.NONE, description: 'Show help' }),
      ],
    })
    const out = renderHelp('gws thing send', spec)
    expect(out).toContain('gws thing send: Send a thing.')
    expect(out).toContain('Usage: gws thing send [flags]')
    expect(out).toContain('--to <text>')
    expect(out).toContain('Recipient')
    expect(out).toContain('--help')
  })

  it('falls back to bare name when description is null', () => {
    const spec = new CommandSpec({ options: [] })
    const out = renderHelp('foo', spec)
    expect(out.split('\n')[0]).toBe('foo')
  })
})
