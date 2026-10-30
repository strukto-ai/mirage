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

import { onMount } from '../../test-utils.ts'
import { GENERIC_COMMANDS } from '../../commands/builtin/generic_bind/factory.ts'
import { describe, expect, it } from 'vitest'
import { materialize } from '../../io/types.ts'
import { RAMVFS } from './ram.ts'
import { PathSpec } from '../../types.ts'

const LOOK = GENERIC_COMMANDS.find((c) => c.name === 'look' && c.filetype == null)

describe('look', () => {
  it('answers a file without a prefix with bad usage', async () => {
    if (LOOK === undefined) throw new Error('look not registered')
    const vfs = new RAMVFS()
    vfs.store.files.set('/tmp/a', new TextEncoder().encode('apple\n'))
    const result = await onMount(vfs, (files) =>
      LOOK.fn(
        (vfs as { accessor?: unknown }).accessor as never,
        [PathSpec.fromStrPath('/tmp/a')],
        [],
        {
          stdin: null,
          flags: {},
          vfs: files,
          cwd: PathSpec.fromStrPath('/'),
        },
      ),
    )
    if (result === null) throw new Error('look returned no result')
    const [out, io] = result
    expect(out).toBeNull()
    expect(io.exitCode).toBe(1)
    expect(
      new TextDecoder().decode(await materialize(io.stderr)).startsWith('look: bad usage\n'),
    ).toBe(true)
  })
})
