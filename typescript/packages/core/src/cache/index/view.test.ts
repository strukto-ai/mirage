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

import { describe, expect, it, vi } from 'vitest'
import {
  IndexEntry,
  IndexType,
  LookupStatus,
  type IndexConfig,
  type RedisIndexConfig,
} from './config.ts'
import { RAMResource } from '../../resource/ram/ram.ts'
import { runWithSession } from '../../context/session_context.ts'
import { FileStat, FileType, MountMode, PathSpec } from '../../types.ts'
import { Session } from '../../workspace/session/session.ts'
import { Workspace } from '../../workspace/workspace/workspace.ts'

const cases = ['backend', 'store'].flatMap((phase) =>
  ['put', 'setDir'].flatMap((method) => [false, true].map((shadow) => ({ phase, method, shadow }))),
)

for (const type of [IndexType.RAM, IndexType.REDIS]) {
  describe(`index lifecycle (${type})`, () => {
    it
      .skipIf(type === IndexType.REDIS && process.env.REDIS_URL === undefined)
      .each(['readlink', 'rename'])(
      'fences metadata writes from internal %s probes',
      async (op) => {
        const url = process.env.REDIS_URL
        const config: IndexConfig | RedisIndexConfig =
          type === IndexType.REDIS
            ? {
                type,
                ...(url === undefined ? {} : { url }),
                keyPrefix: `lifecycle:${crypto.randomUUID()}:`,
              }
            : { type }
        const resource = new RAMResource()
        const ws = new Workspace({ '/data': resource }, { index: config, mode: MountMode.WRITE })
        ws.addMount('/alias', resource)
        const index = resource.index
        let enter = (): void => undefined
        let resume = (): void => undefined
        const entered = new Promise<void>((resolve) => {
          enter = resolve
        })
        const release = new Promise<void>((resolve) => {
          resume = resolve
        })
        ws.ops.register({
          name: 'stat',
          resource: 'ram',
          filetype: null,
          write: false,
          fn: async (_accessor, _path, _args, { index }) => {
            if (index === undefined) throw new Error('missing index')
            enter()
            await release
            await index.put(
              '/data/stale',
              new IndexEntry({ id: 'old', name: 'stale', resourceType: 'file' }),
            )
            return new FileStat({
              name: 'source',
              type: op === 'rename' ? FileType.DIRECTORY : FileType.FILE,
            })
          },
        })
        const session = new Session({
          sessionId: 'agent',
          hiddenPaths: { paths: ['/data/source/private'] },
        })
        const reading = runWithSession(session, () =>
          ws.dispatch(
            op,
            '/data/source',
            op === 'rename' ? [PathSpec.fromStrPath('/data/destination')] : [],
          ),
        ).then(
          () => undefined,
          (err: unknown) => (err instanceof Error && 'code' in err ? err.code : undefined),
        )
        try {
          await entered
          await ws.unmount('/data')
          const replacement = new RAMResource()
          ws.addMount('/data', replacement)
          await ws.fs.readdir('/data')
          await replacement.index.put(
            '/data/fresh',
            new IndexEntry({ id: 'new', name: 'fresh', resourceType: 'file' }),
          )
          resume()
          expect(await reading).toBe(op === 'rename' ? 'EACCES' : 'EINVAL')
          for (const candidate of [index, replacement.index]) {
            expect((await candidate.get('/data/stale')).status).toBe(LookupStatus.NOT_FOUND)
          }
          expect((await replacement.index.get('/data/fresh')).entry?.id).toBe('new')
        } finally {
          resume()
          await reading
          await index.clear()
          await ws.close()
        }
      },
    )

    it.skipIf(type === IndexType.REDIS && process.env.REDIS_URL === undefined).each(cases)(
      'fences $phase $method writes across mount changes (shadow=$shadow)',
      async ({ phase, method, shadow }) => {
        const url = process.env.REDIS_URL
        const config: IndexConfig | RedisIndexConfig =
          type === IndexType.REDIS
            ? {
                type,
                ...(url === undefined ? {} : { url }),
                keyPrefix: `lifecycle:${crypto.randomUUID()}:`,
              }
            : { type }
        const resource = new RAMResource()
        const prefix = shadow ? '/' : '/data'
        const ws = new Workspace({ [prefix]: resource }, { index: config })
        ws.addMount('/alias', resource)
        const index = resource.index
        const entry = new IndexEntry({ id: 'old', name: 'stale', resourceType: 'file' })
        let enter = (): void => undefined
        let resume = (): void => undefined
        const entered = new Promise<void>((resolve) => {
          enter = resolve
        })
        const release = new Promise<void>((resolve) => {
          resume = resolve
        })
        const pause = async (): Promise<void> => {
          enter()
          await release
        }
        if (phase === 'store') {
          if (method === 'put') {
            const original = index.put.bind(index)
            vi.spyOn(index, 'put').mockImplementation(async (...args) => {
              await pause()
              await original(...args)
            })
          } else {
            const original = index.setDir.bind(index)
            vi.spyOn(index, 'setDir').mockImplementation(async (...args) => {
              await pause()
              await original(...args)
            })
          }
        }
        ws.ops.register({
          name: 'readdir',
          resource: 'ram',
          filetype: null,
          write: false,
          fn: async (_accessor, _path, _args, { index }) => {
            if (index === undefined) throw new Error('missing index')
            if (phase === 'backend') await pause()
            if (method === 'put') await index.put('/data/stale', entry)
            else await index.setDir('/data', [['stale', entry]])
            return ['/data/stale']
          },
        })
        const reading = ws.fs.readdir('/data')
        let changing: Promise<unknown> | undefined
        const replacement = new RAMResource()
        try {
          await entered
          let changed = false
          if (shadow) {
            ws.addMount('/data', replacement)
            changing = ws.fs.readdir('/data').then(() => {
              changed = true
            })
          } else {
            changing = ws.unmount('/data').then(() => {
              changed = true
            })
          }
          await Promise.resolve()
          if (phase === 'store') {
            expect(changed).toBe(false)
            resume()
          }
          await changing
          if (!shadow) {
            ws.addMount('/data', replacement)
            await ws.fs.readdir('/data')
          }
          await replacement.index.put(
            '/data/fresh',
            new IndexEntry({ id: 'new', name: 'fresh', resourceType: 'file' }),
          )
          resume()
          await reading
          for (const candidate of [index, replacement.index]) {
            expect((await candidate.get('/data/stale')).status).toBe(LookupStatus.NOT_FOUND)
            expect((await candidate.listDir('/data')).entries ?? []).not.toContain('/data/stale')
          }
          expect((await replacement.index.get('/data/fresh')).entry?.id).toBe('new')
        } finally {
          resume()
          await Promise.allSettled([reading, changing])
          await index.clear()
          await ws.close()
        }
      },
    )
  })
}
