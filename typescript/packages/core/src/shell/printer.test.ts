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
import { getTestParser } from '../workspace/fixtures/workspace_fixture.ts'
import { getFunctionBody } from './helpers.ts'
import { ParseScope } from './parse/scope.ts'
import { functionText, storedFunctionText } from './printer.ts'

// getFunctionBody wraps a body under two redirects in a statement of its
// own; the printer finds the definition again from it.
it('reads the definition under its redirects', async () => {
  const statement = (await getTestParser()).parse('f() { echo a; } >o 2>&1').namedChildren[0]
  const definition = statement?.namedChildren[0]
  const body = definition === undefined ? null : getFunctionBody(definition)
  expect(body === null ? null : functionText('f', body)).toBe('f () \n{ \n    echo a\n} > o 2>&1')
})

// bash prints a definition's heredoc bodies after its closing line.
it("prints the definition's own heredocs", async () => {
  const scope = new ParseScope(await getTestParser())
  const source = 'f() { cat; } <<A >/dev/null <<B\na\nA\nb\nB'
  expect(storedFunctionText('f', source, scope)).toBe(
    'f () \n{ \n    cat\n} <<A > /dev/null <<B\na\nA\nb\nB\n',
  )
})
