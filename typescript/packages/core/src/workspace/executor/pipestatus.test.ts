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
import { makeIntegrationWS } from '../fixtures/integration_fixture.ts'

// A fresh shell's PIPESTATUS is empty (pinned on bash 5.2 in an isolated
// run), and a loop that never iterates leaves the record as it stood,
// empty included, as every transparent construct does.
it.each([
  ['echo "[${PIPESTATUS[@]}]"', '[]\n'],
  ['for x in; do :; done; echo "[${PIPESTATUS[@]}]"', '[]\n'],
  ['false; for x in; do :; done; echo ${PIPESTATUS[@]}', '1\n'],
  ['false | true; for x in; do :; done; echo ${PIPESTATUS[@]}', '1 0\n'],
  ['f() { :; }; echo "[${PIPESTATUS[@]}]"', '[]\n'],
  ['x=1; echo "[${PIPESTATUS[@]}]"', '[0]\n'],
])('PIPESTATUS after a construct that runs no pipeline: %s', async (command, stdout) => {
  const { ws } = await makeIntegrationWS()
  try {
    const io = await ws.execute(command)
    expect(io.stdoutText).toBe(stdout)
  } finally {
    await ws.close()
  }
})
