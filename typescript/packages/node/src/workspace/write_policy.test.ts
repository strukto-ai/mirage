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

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MountMode, WritePolicy } from '@struktoai/mirage-core/types'
import { Mount } from '@struktoai/mirage-core/workspace/mount/spec'
import { writeConditions } from '@struktoai/mirage-core/workspace/mount/write_policy'
import {
  applyStateDict,
  buildMountArgs,
  toStateDict,
} from '@struktoai/mirage-core/workspace/snapshot/state'
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

describe('the write policy at the workspace doors', () => {
  it('judges an added mount on the policy it names, as a wire string', async () => {
    const ws = new Workspace({}, { mode: MountMode.WRITE })
    try {
      const entry = ws.addMount(
        '/s3',
        s3(),
        MountMode.WRITE,
        undefined,
        null,
        undefined,
        'conditional',
      )
      expect(entry.write).toBe(WritePolicy.CONDITIONAL)
      expect(() =>
        ws.addMount('/r', new RAMVFS(), MountMode.WRITE, undefined, null, undefined, 'conditional'),
      ).toThrow('ram does not')
    } finally {
      await ws.close()
    }
  })

  it('gives an added mount the workspace default', async () => {
    const ws = new Workspace({}, { mode: MountMode.WRITE, write: WritePolicy.CONDITIONAL })
    try {
      expect(ws.addMount('/s3', s3(), MountMode.WRITE).write).toBe(WritePolicy.CONDITIONAL)
    } finally {
      await ws.close()
    }
  })

  it('keeps the host-built mounts unconditional under a conditional default', async () => {
    const ws = new Workspace(
      { '/s3': s3() },
      { mode: MountMode.WRITE, write: WritePolicy.CONDITIONAL },
    )
    try {
      expect(ws.mount('/s3/').write).toBe(WritePolicy.CONDITIONAL)
      for (const prefix of ['/dev/', '/', '/.bash_history/', '/usr/bin/']) {
        expect(ws.mount(prefix).write, prefix).toBe(WritePolicy.UNCONDITIONAL)
      }
      expect((await ws.shell('echo x > /dev/null')).exitCode).toBe(0)
    } finally {
      await ws.close()
    }
  })

  it('refuses a conditional mount when the cache keeps nothing', () => {
    // A zero cache limit keeps nothing, so no write would have a version.
    expect(() => new Workspace({ '/s3': conditional() }, { cacheLimit: 0 })).toThrow('caches reads')
  })

  it('refuses an added conditional mount when the cache keeps nothing', async () => {
    const ws = new Workspace({}, { mode: MountMode.WRITE, cacheLimit: 0 })
    try {
      expect(() =>
        ws.addMount('/s3', s3(), MountMode.WRITE, undefined, null, undefined, 'conditional'),
      ).toThrow('caches reads')
    } finally {
      await ws.close()
    }
  })

  it.each(['/s3', '/', '/s3/sub'])(
    'never exposes a conditional mount through fuse: %s',
    async (exposed) => {
      // A kernel mount added at runtime skips the constructor's check.
      const ws = new Workspace({ '/s3': conditional() }, { mode: MountMode.WRITE })
      try {
        await expect(ws.addFuseMount(exposed)).rejects.toThrow(/'\/s3\/'.*backend fuse/)
        expect(ws.fuseMountpoints).toEqual({})
      } finally {
        await ws.close()
      }
    },
  )
})

describe('an s3 mount judged on the endpoint its client resolves', () => {
  const names = [
    'AWS_ENDPOINT_URL',
    'AWS_ENDPOINT_URL_S3',
    'AWS_IGNORE_CONFIGURED_ENDPOINT_URLS',
    'AWS_CONFIG_FILE',
    'AWS_SHARED_CREDENTIALS_FILE',
    'AWS_PROFILE',
  ]
  const saved = new Map(names.map((n) => [n, process.env[n]]))
  let dir = ''
  afterEach(() => {
    for (const [n, v] of saved) {
      if (v === undefined) Reflect.deleteProperty(process.env, n)
      else process.env[n] = v
    }
    rmSync(dir, { recursive: true, force: true })
  })
  const AWS = ['copy', 'create', 'delete', 'put']
  const MINIO = ['create', 'put']
  const ENDPOINT = 'endpoint_url = http://minio.local:9000'

  it.each([
    ['the S3 variable', { AWS_ENDPOINT_URL_S3: 'http://minio.local:9000' }, '', MINIO],
    ['the global variable', { AWS_ENDPOINT_URL: 'http://minio.local:9000' }, '', MINIO],
    [
      'an empty S3 variable falls through',
      { AWS_ENDPOINT_URL_S3: '', AWS_ENDPOINT_URL: 'http://minio.local:9000' },
      '',
      MINIO,
    ],
    [
      'the ignore flag',
      {
        AWS_ENDPOINT_URL_S3: 'http://minio.local:9000',
        AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'true',
      },
      '',
      AWS,
    ],
    ['nothing configured', {}, '', AWS],
    ['the default profile', {}, `[default]\n${ENDPOINT}\n`, MINIO],
    [
      "the default profile's services section",
      {},
      `[default]\nservices = m\n\n[services m]\ns3 =\n  ${ENDPOINT}\n`,
      MINIO,
    ],
    ['the AWS_PROFILE profile', { AWS_PROFILE: 'dev' }, `[profile dev]\n${ENDPOINT}\n`, MINIO],
    [
      'only the AWS_PROFILE profile is read',
      { AWS_PROFILE: 'dev' },
      `[default]\n${ENDPOINT}\n[profile dev]\nregion = us-east-1\n`,
      AWS,
    ],
    [
      "the profile's ignore flag",
      {},
      `[default]\n${ENDPOINT}\nignore_configured_endpoint_urls = true\n`,
      AWS,
    ],
    ['a profile that does not exist', { AWS_PROFILE: 'gone' }, `[default]\n${ENDPOINT}\n`, AWS],
  ] as const)('%s', (_name, env, config, expected) => {
    // The SDK client reads the endpoint from the environment and from the
    // shared config file of AWS_PROFILE (not the mount's `profile`); a
    // MinIO reached either way must not be trusted with AWS's row.
    for (const n of names) Reflect.deleteProperty(process.env, n)
    dir = mkdtempSync(join(tmpdir(), 'mirage-aws-'))
    writeFileSync(join(dir, 'config'), config)
    process.env.AWS_CONFIG_FILE = join(dir, 'config')
    process.env.AWS_SHARED_CREDENTIALS_FILE = join(dir, 'credentials')
    for (const [n, v] of Object.entries(env)) process.env[n] = v
    expect([...writeConditions(s3())].sort()).toEqual(expected)
  })
})

describe('a conditional mount under a kernel mount', () => {
  it.each(['/', '/s3/', '/s3/sub/'])('is never added: %s', async (exposed) => {
    // The other order of the fuse refusal: the kernel mount came first.
    const ws = new Workspace({}, { mode: MountMode.WRITE })
    ;(
      ws as unknown as { kernelMounts: { exposed: () => [string, string][] } }
    ).kernelMounts.exposed = () => [[exposed, 'fuse']]
    try {
      expect(() =>
        ws.addMount('/s3', s3(), MountMode.WRITE, undefined, null, undefined, 'conditional'),
      ).toThrow(/'\/s3\/'.*backend fuse/)
      expect(ws.mounts().map((m) => m.prefix)).not.toContain('/s3/')
      ws.addMount('/s3', s3(), MountMode.WRITE)
    } finally {
      await ws.close()
    }
  })

  it('leaves a conditional mount alone beside a kernel mount elsewhere', async () => {
    const ws = new Workspace({}, { mode: MountMode.WRITE })
    ;(
      ws as unknown as { kernelMounts: { exposed: () => [string, string][] } }
    ).kernelMounts.exposed = () => [['/other/', 'fuse']]
    try {
      expect(
        ws.addMount('/s3', s3(), MountMode.WRITE, undefined, null, undefined, 'conditional').write,
      ).toBe(WritePolicy.CONDITIONAL)
    } finally {
      await ws.close()
    }
  })

  it.each([
    ['the backend before the conditions', () => new RAMVFS(), MountMode.WRITE, 'backend fuse'],
    ['read-only before the backend', () => s3(), MountMode.READ, 'needs a writable mount'],
  ] as const)('names faults in verdict order: %s', async (_name, vfs, mode, message) => {
    // The order the shared verdict table pins for the mount door.
    const ws = new Workspace({}, { mode: MountMode.WRITE })
    ;(
      ws as unknown as { kernelMounts: { exposed: () => [string, string][] } }
    ).kernelMounts.exposed = () => [['/', 'fuse']]
    try {
      expect(() =>
        ws.addMount('/x', vfs(), mode, undefined, null, undefined, 'conditional'),
      ).toThrow(message)
    } finally {
      await ws.close()
    }
  })
})

describe('the write policy in a snapshot', () => {
  it('survives a round trip, two mounts with two values', async () => {
    const ws = new Workspace(
      { '/s3': conditional(), '/d': new RAMVFS() },
      { mode: MountMode.WRITE },
    )
    const state = await toStateDict(ws)
    await ws.close()
    const restored = await Workspace.fromState(state, { mode: MountMode.WRITE }, { '/s3/': s3() })
    try {
      expect(restored.mount('/s3/').write).toBe(WritePolicy.CONDITIONAL)
      expect(restored.mount('/d/').write).toBe(WritePolicy.UNCONDITIONAL)
    } finally {
      await restored.close()
    }
  })

  it('keeps each mount write policy through a copy', async () => {
    // S3 comes back through the override path; the saved write policy has
    // to travel with it, as mode does.
    const ws = new Workspace(
      { '/s3': conditional(), '/d': new RAMVFS() },
      { mode: MountMode.WRITE },
    )
    try {
      const copy = await ws.copy()
      try {
        expect(copy.mount('/s3/').write).toBe(WritePolicy.CONDITIONAL)
        expect(copy.mount('/d/').write).toBe(WritePolicy.UNCONDITIONAL)
      } finally {
        await copy.close()
      }
    } finally {
      await ws.close()
    }
  })

  it('keeps the workspace write default through a copy', async () => {
    // The default a later addMount takes is what the user chose for the
    // workspace; a copy that dropped it would add mounts unconditional.
    const ws = new Workspace(
      { '/s3': s3() },
      { mode: MountMode.WRITE, write: WritePolicy.CONDITIONAL },
    )
    try {
      const copy = await ws.copy()
      try {
        expect(copy.addMount('/more', s3(), MountMode.WRITE).write).toBe(WritePolicy.CONDITIONAL)
      } finally {
        await copy.close()
      }
    } finally {
      await ws.close()
    }
  })

  it('refuses a load override that names another write policy', async () => {
    // The saved policy is kept on an override; one that names another
    // explicitly is refused rather than ignored.
    const ws = new Workspace({ '/s3': conditional() }, { mode: MountMode.WRITE })
    const state = await toStateDict(ws)
    await ws.close()
    await expect(
      Workspace.fromState(
        state,
        { mode: MountMode.WRITE },
        { '/s3/': new Mount(s3(), { mode: MountMode.WRITE, write: WritePolicy.UNCONDITIONAL }) },
      ),
    ).rejects.toThrow('saved write: conditional')
  })

  it('refuses an override that cannot honour the saved policy', async () => {
    // Unlike read, the saved write policy is kept on an override: a
    // stand-in that cannot refuse a stale write is refused loudly rather
    // than restored unconditional.
    const ws = new Workspace({ '/s3': conditional() }, { mode: MountMode.WRITE })
    const state = await toStateDict(ws)
    await ws.close()
    await expect(
      Workspace.fromState(state, { mode: MountMode.WRITE }, { '/s3/': new RAMVFS() }),
    ).rejects.toThrow('ram does not')
  })

  it.each([4, 6])('refuses a v%i snapshot at both doors', async (version) => {
    const ws = new Workspace({ '/d': new RAMVFS() }, { mode: MountMode.WRITE })
    const state = await toStateDict(ws)
    await ws.close()
    expect(() => buildMountArgs({ ...state, version })).toThrow(`v${String(version)} not supported`)
    const target = new Workspace({}, { mode: MountMode.WRITE })
    try {
      await expect(applyStateDict(target, { ...state, version })).rejects.toThrow(
        `v${String(version)} not supported`,
      )
    } finally {
      await target.close()
    }
  })

  it.each([
    ['missing', undefined, 'missing its write policy'],
    ['empty', '', 'missing its write policy'],
    ['banana', 'banana', 'unknown write policy'],
    ['number', 1, "unknown write policy '1'"],
    ['staged', 'staged', 'write: staged needs a staging layer'],
    ['conditional on ram', 'conditional', 'ram does not'],
  ] as const)('judges a saved write policy at load: %s', async (_name, value, message) => {
    // A value no writer of ours would emit is refused, never cast.
    const ws = new Workspace({ '/d': new RAMVFS() }, { mode: MountMode.WRITE })
    const state = await toStateDict(ws)
    await ws.close()
    const entry = state.mounts.find((m) => m.prefix === '/d/') as unknown as Record<string, unknown>
    if (value === undefined) delete entry.write
    else entry.write = value
    await expect(Workspace.fromState(state, { mode: MountMode.WRITE })).rejects.toThrow(message)
  })
})

describe('the workspace write default in a snapshot', () => {
  it.each([
    ['missing', undefined, 'missing its workspace write policy'],
    ['empty', '', 'missing its workspace write policy'],
    ['banana', 'banana', "unknown write policy 'banana'"],
    ['number', 1, "unknown write policy '1'"],
  ] as const)('is judged at load: %s', async (_name, value, message) => {
    // A snapshot without it would restore the workspace unconditional, so a
    // mount added later would write blind; it is refused instead.
    const ws = new Workspace({ '/d': new RAMVFS() }, { mode: MountMode.WRITE })
    const state = (await toStateDict(ws)) as unknown as Record<string, unknown>
    await ws.close()
    if (value === undefined) delete state.write
    else state.write = value
    await expect(
      Workspace.fromState(state as unknown as Awaited<ReturnType<typeof toStateDict>>, {
        mode: MountMode.WRITE,
      }),
    ).rejects.toThrow(message)
  })

  it('refuses an option naming another default', async () => {
    const ws = new Workspace(
      { '/d': new Mount(new RAMVFS(), { mode: MountMode.WRITE, write: 'unconditional' }) },
      { mode: MountMode.WRITE, write: 'conditional' },
    )
    const state = await toStateDict(ws)
    await ws.close()
    await expect(
      Workspace.fromState(state, { mode: MountMode.WRITE, write: 'unconditional' }),
    ).rejects.toThrow('saved write: conditional')
  })

  it('keeps the saved default when an option leaves write undefined', async () => {
    // A JS caller or a looser tsconfig can spread write: undefined in.
    const ws = new Workspace(
      { '/d': new Mount(new RAMVFS(), { mode: MountMode.WRITE, write: 'unconditional' }) },
      { mode: MountMode.WRITE, write: 'conditional' },
    )
    const state = await toStateDict(ws)
    await ws.close()
    const options = { mode: MountMode.WRITE, write: undefined } as unknown as Parameters<
      typeof Workspace.fromState
    >[1]
    const restored = await Workspace.fromState(state, options)
    try {
      expect(restored.addMount('/more', s3(), MountMode.WRITE).write).toBe(WritePolicy.CONDITIONAL)
    } finally {
      await restored.close()
    }
  })
})

describe('a version kept without bytes', () => {
  it('is left out of a snapshot', async () => {
    // It has no bytes to restore; captured as an entry it would come back
    // as an empty file under that token.
    const ws = new Workspace({ '/d': new RAMVFS() }, { mode: MountMode.WRITE })
    try {
      await ws.cache.set('/d/a', new TextEncoder().encode('bytes'), { fingerprint: 'v1' })
      await ws.cache.setVersions({ '/d/b': 'v2' })
      const state = await toStateDict(ws)
      expect(state.cache.entries.map((e) => e.key)).toEqual(['/d/a'])
    } finally {
      await ws.close()
    }
  })
})
