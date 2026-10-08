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

import { MountMode, WritePolicy } from '@struktoai/mirage-core/types'
import { Mount } from '@struktoai/mirage-core/workspace/mount/spec'
import { writeConditions } from '@struktoai/mirage-core/workspace/mount/write_policy'
import { toStateDict } from '@struktoai/mirage-core/workspace/snapshot/state'
import type { WorkspaceStateDict } from '@struktoai/mirage-core/workspace/snapshot/types'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { afterEach, describe, expect, it } from 'vitest'
import type { S3Config } from '../vfs/s3/config.ts'
import { S3VFS } from '../vfs/s3/s3.ts'
import { Workspace } from '../workspace.ts'

function s3(): S3VFS {
  const config: S3Config = {
    bucket: 'b',
    region: 'us-east-1',
    accessKeyId: 'fake',
    secretAccessKey: 'fake',
  }
  return new S3VFS(config)
}

function conditional(): Mount {
  return new Mount(s3(), { mode: MountMode.WRITE, write: WritePolicy.CONDITIONAL })
}

const built: Workspace[] = []

function track(ws: Workspace): Workspace {
  built.push(ws)
  return ws
}

afterEach(async () => {
  for (const ws of built.splice(0).reverse()) await ws.close()
})

async function savedState(
  mounts: Record<string, Mount | RAMVFS>,
  write: WritePolicy = WritePolicy.UNCONDITIONAL,
): Promise<WorkspaceStateDict> {
  const ws = new Workspace(mounts, { mode: MountMode.WRITE, write })
  try {
    return await toStateDict(ws)
  } finally {
    await ws.close()
  }
}

describe('the write policy at the workspace doors', () => {
  it.each([
    ['names', {}, s3, 'conditional', WritePolicy.CONDITIONAL],
    ['cannot honour', {}, () => new RAMVFS(), 'conditional', 'ram does not'],
    ['inherits', { write: WritePolicy.CONDITIONAL }, s3, undefined, WritePolicy.CONDITIONAL],
    ['keeps nothing', { cacheLimit: 0 }, s3, 'conditional', 'caches reads'],
  ] as const)(
    'judges an added mount on its write policy: %s',
    (_name, options, vfs, write, expected) => {
      // The wire string, not the enum: the programmatic door coerces first.
      const ws = track(new Workspace({}, { mode: MountMode.WRITE, ...options }))
      const add = () => ws.addMount('/m', vfs(), MountMode.WRITE, undefined, null, undefined, write)
      if (expected === WritePolicy.CONDITIONAL) expect(add().write).toBe(expected)
      else expect(add).toThrow(expected)
    },
  )

  it('keeps the host-built mounts unconditional under a conditional default', async () => {
    const ws = track(
      new Workspace({ '/s3': s3() }, { mode: MountMode.WRITE, write: WritePolicy.CONDITIONAL }),
    )
    expect(ws.mount('/s3/').write).toBe(WritePolicy.CONDITIONAL)
    for (const prefix of ['/dev/', '/', '/.bash_history/', '/usr/bin/']) {
      expect(ws.mount(prefix).write, prefix).toBe(WritePolicy.UNCONDITIONAL)
    }
    expect((await ws.shell('echo x > /dev/null')).exitCode).toBe(0)
  })

  it('refuses a conditional mount when the cache keeps nothing', () => {
    // A zero cache limit keeps nothing, so no write would have a version.
    expect(() => new Workspace({ '/s3': conditional() }, { cacheLimit: 0 })).toThrow('caches reads')
  })
})

describe('an s3 mount judged on its declared endpoint', () => {
  const names = ['AWS_ENDPOINT_URL', 'AWS_ENDPOINT_URL_S3', 'AWS_IGNORE_CONFIGURED_ENDPOINT_URLS']
  const saved = new Map(names.map((n) => [n, process.env[n]]))
  afterEach(() => {
    for (const [n, v] of saved) {
      if (v === undefined) Reflect.deleteProperty(process.env, n)
      else process.env[n] = v
    }
  })
  const AWS = ['copy', 'delete', 'put']
  const MINIO = ['put']

  it.each([
    ['the S3 variable', { AWS_ENDPOINT_URL_S3: 'http://minio.local:9000' }, MINIO],
    ['the global variable', { AWS_ENDPOINT_URL: 'http://minio.local:9000' }, MINIO],
    [
      'an empty S3 variable falls through',
      { AWS_ENDPOINT_URL_S3: '', AWS_ENDPOINT_URL: 'http://minio.local:9000' },
      MINIO,
    ],
    [
      'the ignore flag',
      {
        AWS_ENDPOINT_URL_S3: 'http://minio.local:9000',
        AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'true',
      },
      AWS,
    ],
    ['nothing configured', {}, AWS],
  ] as const)('%s', (_name, env, expected) => {
    // The declared endpoint, else the env.
    for (const n of names) Reflect.deleteProperty(process.env, n)
    for (const [n, v] of Object.entries(env)) process.env[n] = v
    expect([...writeConditions(s3())].sort()).toEqual(expected)
  })
})

describe('the write policy in a snapshot', () => {
  it.each(['state', 'copy'])('survives the %s door', async (door) => {
    // Two mounts with two values and a workspace default for later mounts.
    const ws = track(
      new Workspace(
        {
          '/s3': s3(),
          '/d': new Mount(new RAMVFS(), { mode: MountMode.WRITE, write: 'unconditional' }),
        },
        { mode: MountMode.WRITE, write: WritePolicy.CONDITIONAL },
      ),
    )
    const back = track(
      door === 'copy'
        ? await ws.copy()
        : await Workspace.fromState(
            await toStateDict(ws),
            { mode: MountMode.WRITE },
            { '/s3/': s3() },
          ),
    )
    expect(back.mount('/s3/').write).toBe(WritePolicy.CONDITIONAL)
    expect(back.mount('/d/').write).toBe(WritePolicy.UNCONDITIONAL)
    expect(back.addMount('/more', s3(), MountMode.WRITE).write).toBe(WritePolicy.CONDITIONAL)
  })

  it.each([
    ['cannot honour', () => new RAMVFS(), 'ram does not'],
    [
      'names another',
      () => new Mount(s3(), { mode: MountMode.WRITE, write: WritePolicy.UNCONDITIONAL }),
      'saved write: conditional',
    ],
  ] as const)(
    'refuses a load override that %s the saved policy',
    async (_name, override, message) => {
      // Unlike read, the saved write policy is kept: an override is refused.
      const state = await savedState({ '/s3': conditional() })
      await expect(
        Workspace.fromState(state, { mode: MountMode.WRITE }, { '/s3/': override() }),
      ).rejects.toThrow(message)
    },
  )

  it.each([
    ['mount', undefined, 'missing its write policy'],
    ['mount', 1, "unknown write policy '1'"],
    ['mount', 'staged', 'write: staged needs a staging layer'],
    ['mount', 'conditional', 'ram does not'],
    ['workspace', undefined, 'missing its workspace write policy'],
    ['workspace', 1, "unknown write policy '1'"],
  ] as const)('judges a saved %s write policy at load: %j', async (level, value, message) => {
    // A value no writer of ours would emit is refused, never cast.
    const state = await savedState({ '/d': new RAMVFS() })
    const holder = (level === 'mount'
      ? state.mounts.find((m) => m.prefix === '/d/')
      : state) as unknown as Record<string, unknown>
    if (value === undefined) delete holder.write
    else holder.write = value
    await expect(Workspace.fromState(state, { mode: MountMode.WRITE })).rejects.toThrow(message)
  })

  it('refuses an option naming another default', async () => {
    const state = await savedState(
      { '/d': new Mount(new RAMVFS(), { mode: MountMode.WRITE, write: 'unconditional' }) },
      WritePolicy.CONDITIONAL,
    )
    await expect(
      Workspace.fromState(state, { mode: MountMode.WRITE, write: 'unconditional' }),
    ).rejects.toThrow('saved write: conditional')
  })

  it('keeps the saved default when an option leaves write undefined', async () => {
    // A JS caller or a looser tsconfig can spread write: undefined in.
    const state = await savedState(
      { '/d': new Mount(new RAMVFS(), { mode: MountMode.WRITE, write: 'unconditional' }) },
      WritePolicy.CONDITIONAL,
    )
    const options = { mode: MountMode.WRITE, write: undefined } as unknown as Parameters<
      typeof Workspace.fromState
    >[1]
    const restored = track(await Workspace.fromState(state, options))
    expect(restored.addMount('/more', s3(), MountMode.WRITE).write).toBe(WritePolicy.CONDITIONAL)
  })

  it('leaves a version kept without bytes out', async () => {
    // It has no bytes to restore; captured, it would come back an empty file.
    const ws = track(new Workspace({ '/d': new RAMVFS() }, { mode: MountMode.WRITE }))
    await ws.cache.set('/d/a', new TextEncoder().encode('bytes'), { fingerprint: 'v1' })
    await ws.cache.setVersions({ '/d/b': 'v2' })
    const state = await toStateDict(ws)
    expect(state.cache.entries.map((e) => e.key)).toEqual(['/d/a'])
  })
})
