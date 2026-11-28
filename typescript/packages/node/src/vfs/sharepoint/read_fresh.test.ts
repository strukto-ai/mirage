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
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { DRIVE_NAME, GraphDrive, SITE_NAME } from '../../../../core/tests/fixtures/graph_drive.ts'
import { serve } from '../../../../core/tests/fixtures/kit_fake.ts'
import { Workspace } from '../../workspace.ts'
import { buildVfs } from '../registry.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()
const OLD = ENC.encode('version one\n')
const NEW = ENC.encode('version two, longer\n')
const SCOPED = '/m/a.txt'
const UNSCOPED = `/m/${SITE_NAME}/${DRIVE_NAME}/a.txt`

let origin = ''
let drives: GraphDrive[] = []

beforeAll(async () => {
  origin = await serve('onedrive')
})

afterEach(async () => {
  await Promise.all(drives.map((drive) => drive.run.close()))
  drives = []
})

// A library of its own holding `data` at a.txt, its requests recorded from
// after it.
async function driveOf(data: Uint8Array): Promise<GraphDrive> {
  const drive = new GraphDrive(origin, DRIVE_NAME)
  drives.push(drive)
  await drive.reset()
  await drive.write('a.txt', data)
  await drive.run.recordRequests()
  return drive
}

function vfsOf(drive: GraphDrive, scoped = true): Promise<BaseVFS> {
  if (scoped) return buildVfs('sharepoint', drive.config('sharepoint'))
  return buildVfs('sharepoint', { access_token: drive.token, graph_base_url: drive.run.url })
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

// The unscoped mount resolves the site and drive out of the path, a different
// road to the same item than the scoped one.
const ROWS: [string, boolean, string][] = [
  ['scoped-stream', true, 'cat {v}'],
  ['scoped-bytes', true, 'cp {v} /r/x && cat /r/x'],
  ['unscoped-stream', false, 'cat {v}'],
]

describe('sharepoint under read: fresh', () => {
  it.each([false, true])(
    'keeps hidden sites inaccessible by internal name (warm=%s)',
    async (warm) => {
      const drive = await driveOf(OLD)
      const w = ws(await vfsOf(drive, false))
      try {
        if (warm) expect(await out(w, `cat ${UNSCOPED}`)).toBe(DEC.decode(OLD))
        w.createSession('hidden', { profile: { paths: { hide: [`/m/${SITE_NAME}`] } } })
        const token = await drive.ctag('a.txt')
        await drive.run.recordRequests()
        const alias = `/m/${SITE_NAME.toLowerCase()}/${DRIVE_NAME}`
        for (const command of [`cat ${alias}/a.txt`, `echo changed > ${alias}/a.txt`]) {
          const result = await w.shell(command, { sessionId: 'hidden' })
          expect(result.exitCode, command).not.toBe(0)
          expect(DEC.decode(result.stdout), command).not.toContain(DEC.decode(OLD))
        }
        const listing = await w.shell(`ls ${alias}`, { sessionId: 'hidden' })
        expect(DEC.decode(listing.stdout)).toBe('')
        expect(await drive.ctag('a.txt')).toBe(token)
        expect(await drive.fetches()).toBe(0)
        expect(await drive.count('children')).toBe(0)
        expect(await drive.count('drives')).toBe(0)
        expect(await out(w, `cat ${UNSCOPED}`)).toBe(DEC.decode(OLD))
      } finally {
        await w.close()
      }
    },
  )

  it.each(ROWS)(
    'refetches a write between the token and the bytes (%s)',
    async (_id, scoped, template) => {
      const drive = await driveOf(OLD)
      const first = await drive.ctag('a.txt')
      const w = ws(await vfsOf(drive, scoped))
      const command = template.replace('{v}', scoped ? SCOPED : UNSCOPED)
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
    },
  )

  it('a listed cTag never answers for a changed file', async () => {
    const drive = await driveOf(OLD)
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
      expect(await out(w, `cat ${SCOPED}`)).toBe(DEC.decode(OLD))
      await drive.write('a.txt', NEW)
      expect(await out(w, `cat ${SCOPED}`)).toBe(DEC.decode(NEW))
      expect([await drive.count('children'), await drive.reach(1)]).toEqual([1, []])
    } finally {
      await w.close()
    }
  })

  it('a metadata edit does not refetch', async () => {
    const drive = await driveOf(OLD)
    const w = ws(await vfsOf(drive))
    try {
      await out(w, `cat ${SCOPED}`)
      // A rename or a property edit moves the eTag and the stamp, never the
      // cTag, so the cached bytes are still current.
      await drive.touch('a.txt')
      expect(await out(w, `cat ${SCOPED}`)).toBe(DEC.decode(OLD))
      expect(await drive.fetches()).toBe(0)
    } finally {
      await w.close()
    }
  })
})
