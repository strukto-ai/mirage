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

import type { OneDriveAccessor } from '@struktoai/mirage-core/accessor/onedrive'
import { read } from '@struktoai/mirage-core/core/onedrive/read'
import { readStream } from '@struktoai/mirage-core/core/onedrive/stream'
import { currentCaller, bindCaller } from '@struktoai/mirage-core/context/session_context'
import { recordingScope } from '@struktoai/mirage-core/observe/context'
import {
  DEFAULT_READ_TTL,
  type FileStat,
  MountMode,
  PathSpec,
  ReadPolicy,
} from '@struktoai/mirage-core/types'
import type { BaseVFS } from '@struktoai/mirage-core/vfs/base'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { Mount } from '@struktoai/mirage-core/workspace/mount/spec'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { DRIVE_NAME, GraphDrive } from '../../../../core/tests/fixtures/graph_drive.ts'
import { serve } from '../../../../core/tests/fixtures/kit_fake.ts'
import { Workspace } from '../../workspace.ts'
import { buildVfs } from '../registry.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()
const OLD = ENC.encode('version one\n')
const NEW = ENC.encode('version two, longer\n')
const CAT = 'cat /m/a.txt'
const CP = 'cp /m/a.txt /r/x && cat /r/x'

let origin = ''
let drives: GraphDrive[] = []

beforeAll(async () => {
  origin = await serve('onedrive')
})

afterEach(async () => {
  await Promise.all(drives.map((drive) => drive.run.close()))
  drives = []
})

// A drive of its own holding `files`, its requests recorded from after them.
async function driveOf(files: Record<string, Uint8Array>, id?: string): Promise<GraphDrive> {
  const drive = new GraphDrive(origin, id)
  drives.push(drive)
  await drive.reset()
  for (const [path, data] of Object.entries(files)) await drive.write(path, data)
  await drive.run.recordRequests()
  return drive
}

function vfsOf(drive: GraphDrive): Promise<BaseVFS> {
  return buildVfs('onedrive', drive.config('onedrive'))
}

function ws(vfs: BaseVFS): Workspace {
  return new Workspace(
    {
      '/m': new Mount(vfs, {
        mode: MountMode.WRITE,
        read: { policy: ReadPolicy.FRESH, ttl: DEFAULT_READ_TTL },
      }),
      '/r': [new RAMVFS(), MountMode.WRITE],
    },
    { cache: {} },
  )
}

async function out(workspace: Workspace, command: string): Promise<string> {
  const result = await workspace.shell(command)
  expect([result.exitCode, DEC.decode(result.stderr)], command).toEqual([0, ''])
  return DEC.decode(result.stdout)
}

const SPEC = new PathSpec({ virtual: '/a.txt', directory: '/', vfsPath: 'a.txt' })

describe('onedrive under read: fresh', () => {
  it.each([
    ['stream', CAT],
    ['bytes', CP],
  ])('refetches a write between the token and the bytes (%s)', async (_row, command) => {
    const drive = await driveOf({ 'a.txt': OLD })
    const first = await drive.ctag('a.txt')
    const w = ws(await vfsOf(drive))
    try {
      // The file changes after the bytes are taken and before they are sent,
      // so the read holds OLD while Graph already holds NEW. A token read
      // after the bytes would label OLD with NEW's cTag.
      await drive.writeAfterTheBytes('a.txt', NEW)
      expect(await out(w, command)).toBe(DEC.decode(OLD))
      expect(await drive.ctag('a.txt')).not.toBe(first)
      const before = await drive.fetches()
      expect(await out(w, command)).toBe(DEC.decode(NEW))
      expect((await drive.fetches()) - before).toBe(1)
      expect(await drive.reach()).toEqual([])
    } finally {
      await w.close()
    }
  })

  it('an unrecorded read fetches the bare item, then its bytes', async () => {
    const drive = await driveOf({ 'a.txt': OLD })
    const vfs = await vfsOf(drive)
    let data: Uint8Array
    try {
      data = await read(vfs.accessor as OneDriveAccessor, SPEC)
    } finally {
      await vfs.close()
    }
    expect(DEC.decode(data)).toBe(DEC.decode(OLD))
    // No version history: the revision only matters to a snapshot, and only a
    // recorded read can land in one.
    expect(await drive.log()).toEqual([
      ['item', 'a.txt', ''],
      ['download', 'a.txt', ''],
    ])
  })

  it.each(['bytes', 'stream'])(
    'a recorded %s read keeps the revision snapshots pin',
    async (slot) => {
      const drive = await driveOf({ 'a.txt': OLD })
      await drive.write('a.txt', NEW)
      await drive.run.recordRequests()
      const accessor = (await vfsOf(drive)).accessor as OneDriveAccessor
      const [data, records] = await recordingScope(async () => {
        if (slot === 'bytes') return read(accessor, SPEC)
        const parts: Uint8Array[] = []
        for await (const chunk of readStream(accessor, SPEC)) parts.push(chunk)
        return Buffer.concat(parts)
      })
      expect(DEC.decode(data)).toBe(DEC.decode(NEW))
      expect(await drive.queries('item')).toEqual(['$expand=versions'])
      expect(records.map((r) => [r.fingerprint, r.revision])).toEqual([
        [await drive.ctag('a.txt'), '2.0'],
      ])
    },
  )

  it.each([
    ['1.0', OLD],
    ['9.0', null],
  ] as const)('a pinned read of %s gets that version bytes', async (pin, expected) => {
    const drive = await driveOf({ 'a.txt': OLD })
    await drive.write('a.txt', NEW)
    await drive.run.recordRequests()
    const vfs = await vfsOf(drive)
    const pinned = (): Promise<Uint8Array> =>
      bindCaller({ ...currentCaller(), revisions: { map: new Map([['/a.txt', pin]]) } }, () =>
        read(vfs.accessor as OneDriveAccessor, SPEC),
      )
    try {
      // A snapshot pin reads the version it names, straight from its content
      // route, even after a rewrite; a version the item never had is absent.
      if (expected === null) {
        await expect(pinned()).rejects.toMatchObject({ code: 'ENOENT' })
      } else {
        expect(DEC.decode(await pinned())).toBe(DEC.decode(expected))
      }
    } finally {
      await vfs.close()
    }
    expect((await drive.log()).map(([route]) => route)).toEqual(['item', 'version_content'])
  })

  it('a ranged read stamps the whole item cTag', async () => {
    const drive = await driveOf({ 'a.txt': OLD })
    const accessor = (await vfsOf(drive)).accessor as OneDriveAccessor
    const [data, records] = await recordingScope(() => read(accessor, SPEC, { offset: 2, size: 3 }))
    expect(DEC.decode(data)).toBe(DEC.decode(OLD.slice(2, 5)))
    expect(records.map((r) => r.fingerprint)).toEqual([await drive.ctag('a.txt')])
    expect([await drive.count('download'), await drive.count('content')]).toEqual([1, 0])
  })

  it('a listed cTag never answers for a changed file', async () => {
    const drive = await driveOf({ 'a.txt': OLD })
    const first = await drive.ctag('a.txt')
    const w = ws(await vfsOf(drive))
    try {
      // The listing leaves the first cTag in the mount index. A probe that
      // trusted it would match the one the cache holds and serve OLD.
      await out(w, 'ls /m')
      // The fixture held: the mount index answers a stat with that cTag and
      // no request of its own, so there is a stale row to trust.
      const mount = w.mount('/m')
      const index = mount.index
      const items = await drive.count('item')
      const listed = (await mount.callKeyed(
        'stat',
        new PathSpec({ virtual: '/m/a.txt', directory: '/m/', vfsPath: 'a.txt' }),
        [],
        { index },
      )) as FileStat
      expect([listed.fingerprint, await drive.count('item')]).toEqual([first, items])
      expect(await out(w, CAT)).toBe(DEC.decode(OLD))
      await drive.write('a.txt', NEW)
      expect(await out(w, CAT)).toBe(DEC.decode(NEW))
      expect([await drive.count('children'), await drive.reach(1)]).toEqual([1, []])
    } finally {
      await w.close()
    }
  })

  it.each([false, true])('a dispatcher read stamps its cTag (streamed: %s)', async (streamed) => {
    const drive = await driveOf({ 'a.txt': OLD })
    const w = ws(await vfsOf(drive))
    try {
      let got = ''
      if (streamed) {
        for await (const chunk of await w.vfs.read('/m/a.txt', { stream: true }))
          got += DEC.decode(chunk)
      } else {
        got = DEC.decode(await w.vfs.read('/m/a.txt'))
      }
      expect(got).toBe(DEC.decode(OLD))
      const before = await drive.fetches()
      expect(await out(w, CAT)).toBe(DEC.decode(OLD))
      expect(await drive.fetches()).toBe(before)
    } finally {
      await w.close()
    }
  })

  it('a metadata edit does not refetch', async () => {
    const drive = await driveOf({ 'a.txt': OLD })
    const w = ws(await vfsOf(drive))
    try {
      await out(w, CAT)
      // A rename or a property edit moves the eTag and the stamp, never the
      // cTag, so the cached bytes are still current.
      await drive.touch('a.txt')
      expect(await out(w, CAT)).toBe(DEC.decode(OLD))
      expect(await drive.fetches()).toBe(0)
    } finally {
      await w.close()
    }
  })
})

// Measured in python on the first green run, then pinned; the two hosts must
// agree. The listing makes every ordinary stat an index hit, so what is left
// is the reconcile probe: a command pays it at its first lookup of the operand
// its line names, and the cache gate reuses it. A warm read downloads nothing
// and lists nothing.
const WARM: [string, number][] = [
  [CAT, 1],
  ['cat /m/a.txt | head -c 1', 1],
  ['cp /m/a.txt /r/a.txt', 1],
]

describe('onedrive warm read cost', () => {
  it.each(WARM)('%s costs one item per probe', async (command, items) => {
    const drive = await driveOf({ 'a.txt': OLD })
    const w = ws(await vfsOf(drive))
    try {
      await out(w, 'ls /m')
      await out(w, CAT)
      await drive.run.recordRequests()
      await out(w, command)
      expect([
        await drive.count('item'),
        await drive.fetches(),
        await drive.count('children'),
      ]).toEqual([items, 0, 0])
    } finally {
      await w.close()
    }
  })
})

// A re-list is the backend's own answer, so a file it no longer names loses
// what mirage kept for it. Asserted right after the `ls`, before anything
// reads the path, since a stat of it reaches the per-file cleanup anyway.
it('cleans up the bytes and overlay of a file a re-list drops', async () => {
  const drive = await driveOf({ 'a.txt': OLD, 'b.txt': ENC.encode('bravo\n') })
  const w = new Workspace(
    {
      '/m': new Mount(await vfsOf(drive), {
        mode: MountMode.WRITE,
        read: { policy: ReadPolicy.BOUNDED, ttl: 600 },
      }),
    },
    { cache: {} },
  )
  try {
    expect(await out(w, 'ls /m')).toBe('a.txt\nb.txt\n')
    expect(await out(w, 'cat /m/a.txt')).toBe('version one\n')
    await w.namespace.setAttrs('/m/a.txt', { mode: 0o600 })
    expect(await w.cache.exists('/m/a.txt')).toBe(true)
    await drive.remove('a.txt')
    await w.registry.mountFor('/m/a.txt').index.invalidate()
    expect(await out(w, 'ls /m')).toBe('b.txt\n')
    expect(w.namespace.metaFor('/m/a.txt')).toBeNull()
    expect(await w.cache.exists('/m/a.txt')).toBe(false)
    expect((await w.shell('stat /m/a.txt')).exitCode).toBe(1)
  } finally {
    await w.close()
  }
})

// No ttl to wait out: under fresh the next command re-lists, and that re-list
// is what finds the file gone.
it('re-lists on the next command under fresh and cleans up', async () => {
  const drive = await driveOf({ 'a.txt': OLD, 'b.txt': ENC.encode('bravo\n') })
  const w = ws(await vfsOf(drive))
  try {
    expect(await out(w, 'ls /m')).toBe('a.txt\nb.txt\n')
    expect(await out(w, 'cat /m/a.txt')).toBe('version one\n')
    await w.namespace.setAttrs('/m/a.txt', { mode: 0o600 })
    await drive.remove('a.txt')
    expect(await out(w, 'ls /m')).toBe('b.txt\n')
    expect(w.namespace.metaFor('/m/a.txt')).toBeNull()
    expect(await w.cache.exists('/m/a.txt')).toBe(false)
  } finally {
    await w.close()
  }
})

it.each(['onedrive', 'sharepoint'])(
  'refuses hidden %s aliases over a folding service',
  async (provider) => {
    const drive = await driveOf(
      { 'secret.txt': ENC.encode('secret'), 'vault/private.txt': ENC.encode('private') },
      provider === 'onedrive' ? undefined : DRIVE_NAME,
    )
    // Graph matches paths in any case; the fake matches them exactly, so the
    // path an item URL names is lowercased on its way there, as the names
    // the drive holds already are.
    const nativeFetch = globalThis.fetch
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      const index = url.pathname.indexOf('/root:/')
      if (index >= 0)
        url.pathname =
          url.pathname.slice(0, index + 7) + url.pathname.slice(index + 7).toLowerCase()
      return nativeFetch(url, init)
    })
    const vfs = await buildVfs(provider, drive.config(provider))
    const w = new Workspace({ '/m': [vfs, MountMode.WRITE] })
    try {
      expect((await w.shell('cat /m/secret.txt /m/vault/private.txt')).exitCode).toBe(0)
      w.createSession('hidden', { profile: { paths: { hide: ['/m/secret.txt', '/m/vault'] } } })
      const token = await drive.ctag('secret.txt')
      await drive.run.recordRequests()
      for (const command of [
        'cat /m/SECRET.txt',
        'cat /m/Vault/private.txt',
        'ls /m/Vault',
        'echo changed > /m/SECRET.txt',
        'echo changed > /m/Vault/new.txt',
      ]) {
        const result = await w.shell(command, { sessionId: 'hidden' })
        expect(result.exitCode, command).not.toBe(0)
        expect(DEC.decode(result.stdout), command).not.toContain('secret')
      }
      expect(await drive.ctag('secret.txt')).toBe(token)
      expect(
        (await drive.log()).filter(([route]) =>
          ['upload', 'download', 'content', 'version_content'].includes(route),
        ),
      ).toEqual([])
    } finally {
      await w.close()
      vi.unstubAllGlobals()
    }
  },
)
