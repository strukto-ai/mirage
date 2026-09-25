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

import { DEFAULT_READ_TTL, MountMode, ReadPolicy } from '@struktoai/mirage-core/types'
import type { VFS } from '@struktoai/mirage-core/vfs/base'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { Mount } from '@struktoai/mirage-core/workspace/mount/spec'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DRIVE_ID,
  DRIVE_NAME,
  FakeGraph,
  SITE_NAME,
  serveGraph,
} from '../../core/msgraph/_test_util.ts'
import { Workspace } from '../../workspace.ts'
import { buildVfs } from '../registry.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()
const OLD = ENC.encode('version one\n')
const NEW = ENC.encode('version two, longer\n')
const SCOPED = '/m/a.txt'
const UNSCOPED = `/m/${SITE_NAME}/${DRIVE_NAME}/a.txt`

let graphs: FakeGraph[] = []

afterEach(async () => {
  await Promise.all(graphs.map((graph) => graph.close()))
  graphs = []
})

async function graphOf(data: Uint8Array, childrenAllowed = 0): Promise<FakeGraph> {
  const graph = new FakeGraph({ [DRIVE_ID]: { 'a.txt': data } })
  graph.childrenAllowed = childrenAllowed
  graphs.push(graph)
  return serveGraph(graph)
}

function vfsOf(graph: FakeGraph, scoped = true): Promise<VFS> {
  return buildVfs('sharepoint', {
    access_token: 't',
    graph_base_url: graph.url,
    ...(scoped ? { site: SITE_NAME, drive: DRIVE_NAME } : {}),
  })
}

function ws(vfs: VFS): Workspace {
  return new Workspace({
    '/m': new Mount(vfs, {
      mode: MountMode.WRITE,
      read: { policy: ReadPolicy.FRESH, ttl: DEFAULT_READ_TTL },
    }),
    '/r': [new RAMVFS(), MountMode.WRITE],
  })
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
  it.each(ROWS)('refetches a write between the token and the bytes (%s)', async (_id, scoped, template) => {
    const graph = await graphOf(OLD)
    const w = ws(await vfsOf(graph, scoped))
    const command = template.replace('{v}', scoped ? SCOPED : UNSCOPED)
    try {
      // The file changes after the bytes are taken and before they are sent,
      // so the read holds OLD while Graph already holds NEW. A token read
      // after the bytes would label OLD with NEW's cTag.
      graph.onBytes(() => {
        graph.write(DRIVE_ID, 'a.txt', NEW)
      })
      expect(await out(w, command)).toBe(DEC.decode(OLD))
      expect(graph.hookFired).toBe(1)
      const before = graph.fetches()
      expect(await out(w, command)).toBe(DEC.decode(NEW))
      expect(graph.fetches() - before).toBe(1)
      expect(graph.reach).toEqual([])
    } finally {
      await w.close()
    }
  })

  it('a listed cTag never answers for a changed file', async () => {
    const graph = await graphOf(OLD, 1)
    const w = ws(await vfsOf(graph))
    try {
      // The listing leaves c1 in the mount index. A probe that trusted it
      // would match the c1 the cache holds and serve OLD.
      await out(w, 'ls /m')
      expect(await out(w, `cat ${SCOPED}`)).toBe(DEC.decode(OLD))
      graph.write(DRIVE_ID, 'a.txt', NEW)
      expect(await out(w, `cat ${SCOPED}`)).toBe(DEC.decode(NEW))
    } finally {
      await w.close()
    }
  })

  it('a metadata edit does not refetch', async () => {
    const graph = await graphOf(OLD)
    const w = ws(await vfsOf(graph))
    try {
      await out(w, `cat ${SCOPED}`)
      // A rename or a property edit moves the eTag and the stamp, never the
      // cTag, so the cached bytes are still current.
      graph.touch(DRIVE_ID, 'a.txt')
      const before = graph.fetches()
      expect(await out(w, `cat ${SCOPED}`)).toBe(DEC.decode(OLD))
      expect(graph.fetches() - before).toBe(0)
    } finally {
      await w.close()
    }
  })
})
