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
import { RAMResource } from '@struktoai/mirage-core/resource/ram/ram'
import { MountMode } from '@struktoai/mirage-core/types'
import { Workspace } from '@struktoai/mirage-node'
import { z } from '@struktoai/mirage-core/resource/secrets'
import { registerSecrets } from '@struktoai/mirage-core/secrets/registry'
import { cloneWorkspaceWithOverride } from './clone.ts'

const AccountConfig = z.strictObject({ account: z.string().default('default') })
type AccountConfig = z.infer<typeof AccountConfig>

describe('cloneWorkspaceWithOverride', () => {
  it('produces an independent workspace whose writes do not touch the source', async () => {
    const src = new Workspace({ '/': new RAMResource() }, { mode: MountMode.WRITE })
    await src.execute('echo source-only > /file.txt')
    const clone = await cloneWorkspaceWithOverride(src, null)
    await clone.execute('echo clone-write > /file.txt')
    const srcRead = await src.execute('cat /file.txt')
    expect(srcRead.stdoutText.trim()).toBe('source-only')
    const cloneRead = await clone.execute('cat /file.txt')
    expect(cloneRead.stdoutText.trim()).toBe('clone-write')
    await src.close()
    await clone.close()
  })

  it('keeps the declared source instances', async () => {
    // State carries the env pointers and never the `secrets:` block
    // behind them, so a clone that does not carry the declarations
    // answers the first read with an unknown source.
    registerSecrets('acct-clone', AccountConfig, (config: AccountConfig, ref: string) =>
      Promise.resolve({ fields: { credential: `${config.account}:${ref}` } }),
    )
    const src = new Workspace(
      { '/': new RAMResource() },
      {
        mode: MountMode.WRITE,
        secrets: { prod: { source: 'acct-clone', config: { account: 'a1' } } },
        env: { TOKEN: { from: 'prod', ref: 'r', key: 'credential' } },
      },
    )
    const clone = await cloneWorkspaceWithOverride(src, null)
    const read = await clone.execute('echo "$TOKEN"')
    expect(read.exitCode).toBe(0)
    expect(read.stdoutText.trim()).toBe('a1:r')
    await src.close()
    await clone.close()
  })

  it('lets an override replace the declared instances', async () => {
    // A staging clone points at its own accounts; keeping the source
    // workspace's would leave it reading production.
    registerSecrets('acct-override', AccountConfig, (config: AccountConfig, ref: string) =>
      Promise.resolve({ fields: { credential: `${config.account}:${ref}` } }),
    )
    const src = new Workspace(
      { '/': new RAMResource() },
      {
        mode: MountMode.WRITE,
        secrets: { prod: { source: 'acct-override', config: { account: 'live' } } },
        env: { TOKEN: { from: 'prod', ref: 'r', key: 'credential' } },
      },
    )
    const clone = await cloneWorkspaceWithOverride(src, {
      secrets: { prod: { source: 'acct-override', config: { account: 'staging' } } },
    })
    expect((await clone.execute('echo "$TOKEN"')).stdoutText.trim()).toBe('staging:r')
    await src.close()
    await clone.close()
  })
})
