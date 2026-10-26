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
import { makeIntegrationWS, run } from '../../../tests/workspace/fixtures/integration_fixture.ts'

it('expands a heredoc body by its own escapes', async () => {
  // The body rides in a double-quoted word, but a quote is plain text in it
  // and a backslash escapes only `$`, a backtick and itself.
  const { ws } = makeIntegrationWS()
  try {
    expect(await run(ws, 'x=v; cat <<E\n"$x" \\"y\\" \\q \\$x \\\\ `echo t`\nE')).toBe(
      '"v" \\"y\\" \\q $x \\ t\n',
    )
  } finally {
    await ws.close()
  }
})
