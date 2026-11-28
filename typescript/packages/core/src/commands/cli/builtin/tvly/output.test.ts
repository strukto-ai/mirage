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
import { context } from '../../../../../tests/workspace/fixtures/context.ts'
import { materialize } from '../../../../io/types.ts'
import { PathSpec } from '../../../../types.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import { Streams, outputSlug, resolveOutput } from './output.ts'

const DEC = new TextDecoder()

// Mirrors python's tests/commands/cli/builtin/tvly/test_output.py.
describe('tvly -o', () => {
  it('slugs a label to its words', () => {
    expect(outputSlug('What is RAG? (2026)')).toBe('what-is-rag-2026')
    expect(outputSlug('!!!')).toBe('result')
    expect(outputSlug('a'.repeat(50))).toBe('a'.repeat(40))
  })

  it('saves nothing without -o', () => {
    expect(resolveOutput(new FlagView({}), context(), 'search', 'q')).toBeUndefined()
  })

  it('keeps a named file as typed', () => {
    const path = PathSpec.fromStrPath('out.json', '/work')
    expect(resolveOutput(new FlagView({ output: path }), context(), 'search', 'q')).toBe(path)
  })

  it('picks a fresh name under .tavily for a bare -o', () => {
    const found = resolveOutput(
      new FlagView({ output: true }),
      context({ cwd: PathSpec.fromStrPath('/work') }),
      'map',
      'docs.example.com',
    )
    expect(found?.rawPath).toMatch(/^\.tavily\/map-docs-example-com-\d{6}-[0-9a-f]{6}\.json$/)
    expect(found?.virtual.startsWith('/work/.tavily/')).toBe(true)
  })

  it('answers with the gathered text and status', async () => {
    const streams = new Streams()
    streams.out('a')
    streams.err('b')
    const [out, result] = streams.result(3)
    expect(DEC.decode(out === null ? new Uint8Array() : await materialize(out))).toBe('a\n')
    expect(DEC.decode(await materialize(result.stderr))).toBe('b\n')
    expect(result.exitCode).toBe(3)
  })
})
