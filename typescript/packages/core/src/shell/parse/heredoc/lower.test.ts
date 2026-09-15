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

import { expect, it } from 'vitest'
import { getTestParser } from '../../../workspace/fixtures/workspace_fixture.ts'
import { lowerHeredocs } from './lower.ts'
import { discoverHeredocs } from './reader.ts'

it('keeps source locations for unicode bodies', () => {
  const source = 'echo é; cat <<終\n世界\n終'
  const lowered = lowerHeredocs(source, discoverHeredocs(source, []))
  expect(lowered.offsets.length).toBe(lowered.source.length + 1)
  const first = lowered.documents[0]
  if (first === undefined) throw new Error('missing heredoc')
  const [start, doc] = first
  expect(lowered.source[start]).toBe('<')
  expect(source.slice(lowered.offsets[start])).toMatch(/^<<終/)
  expect(doc.body).toBe('世界\n')
})

it('keeps heredoc identity through other parser repairs', async () => {
  const parser = await getTestParser()
  const root = parser.parse('cat > /api/$c/$id.json <<EOF\nbody\nEOF')
  expect(root.namedChildren[0]?.namedChildren.at(-1)?.heredoc?.body).toBe('body\n')
})
