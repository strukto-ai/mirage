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

import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import {
  EventHub,
  MountMode,
  NextcloudAccessor,
  NextcloudEventHook,
  NextcloudVFS,
  PathSpec,
  RAMEventQueue,
  Workspace,
  type FileEvent,
  type NextcloudConfig,
} from '@struktoai/mirage-node'

const __HERE = fileURLToPath(new URL('.', import.meta.url))
dotenv.config({ path: resolve(__HERE, '../../../../.env.development'), override: true })

const MOUNT = '/nc'
const FOLDER = 'custom-queue-demo'

function buildConfig(): NextcloudConfig {
  const url = process.env.NEXTCLOUD_URL
  if (url === undefined) throw new Error('NEXTCLOUD_URL is required')
  return {
    url,
    username: process.env.NEXTCLOUD_USERNAME ?? 'admin',
    password: process.env.NEXTCLOUD_PASSWORD ?? 'admin123',
  }
}

const config = buildConfig()
const vfs = new NextcloudVFS(config)
const ws = new Workspace({ [MOUNT]: vfs }, { mode: MountMode.WRITE })
// A separate accessor plays the "external writer": a teammate, a cron
// job, anything mutating Nextcloud behind the workspace's back.
const externalAccessor = new NextcloudAccessor(config)

// The customization hook: attach the runtime yourself instead of
// letting the first events() build the default one. Here every subscription
// gets a tiny RAM queue (3 pending paths) so a burst overflows and
// collapses into one UNKNOWN "re-inventory" event.
ws.attachEventRuntime(
  new EventHub(ws.registry, (roots) => new RAMEventQueue(roots, { maxPending: 3 })),
)

const CREATED = 'OCP\\Files\\Events\\Node\\NodeCreatedEvent'
const DAV = '/remote.php/dav/files/'
const WEBDAV = '/remote.php/webdav'

/**
 * The instance path Nextcloud names `rel` by in a webhook payload.
 *
 * Nextcloud reports a node as `/<user>/files/<path>` from the user's
 * files root, while the mount starts at the folder `NEXTCLOUD_URL`
 * names, so that folder is part of the path.
 */
function serverPath(rel: string): string {
  const path = `${decodeURIComponent(new URL(config.url).pathname).replace(/\/+$/, '')}/`
  let user: string
  let folder: string
  if (path.includes(DAV)) {
    const rest = path.split(DAV).slice(1).join(DAV)
    const cut = rest.indexOf('/')
    user = rest.slice(0, cut)
    folder = rest.slice(cut + 1)
  } else if (path.includes(WEBDAV)) {
    user = String(config.username)
    folder = path.split(WEBDAV).slice(1).join(WEBDAV)
  } else {
    throw new Error(`not a Nextcloud WebDAV URL: ${config.url}`)
  }
  const parts = [`/${user}/files`, folder.replace(/^\/+|\/+$/g, ''), rel]
  return parts.filter((part) => part !== '').join('/')
}

/**
 * Stands in for the consumer's webhook route: each delivery Nextcloud
 * would POST is mapped by `NextcloudEventHook` and fed to notify.
 */
class Receiver {
  private readonly hook = new NextcloudEventHook(vfs.accessor)
  private readonly root = PathSpec.fromStrPath(MOUNT, '')

  async created(rel: string): Promise<void> {
    const payload = {
      event: {
        class: CREATED,
        node: { path: serverPath(rel) },
      },
    }
    for (const change of await this.hook.toEvents(this.root, CREATED, payload)) {
      await ws.notify(change)
    }
  }
}

async function next(events: AsyncIterator<FileEvent>): Promise<FileEvent> {
  const result = await events.next()
  if (result.done === true) throw new Error('events ended before delivery')
  return result.value
}

async function main(): Promise<void> {
  const receiver = new Receiver()
  const external = await externalAccessor.operator()
  await external.createDir(`${FOLDER}/`)

  const events = ws.events(`${MOUNT}/${FOLDER}`)[Symbol.asyncIterator]()
  const first = next(events)
  await delay(50)

  console.log('one external change -> one event:')
  await external.write(`${FOLDER}/report.txt`, Buffer.from('quarterly numbers'))
  await receiver.created(`${FOLDER}/report.txt`)
  let event = await first
  console.log(`  ${event.kind} ${event.path.virtual}`)

  console.log('burst of 5 while the consumer is busy -> queue (cap 3) collapses:')
  for (let i = 0; i < 5; i++) {
    await external.write(`${FOLDER}/bulk-${String(i)}.txt`, Buffer.from('row'))
    await receiver.created(`${FOLDER}/bulk-${String(i)}.txt`)
  }
  event = await next(events)
  console.log(`  ${event.kind} ${event.path.virtual}  (precision degraded, dirtiness kept)`)

  const result = await ws.shell(`ls ${MOUNT}/${FOLDER}`)
  const listing = result.stdoutText.split(/\s+/).filter((name) => name !== '')
  console.log(`  re-inventory: ${String(listing.length)} entries, guaranteed fresh`)

  await events.return?.()
  await ws.detachEventRuntime() // closes every subscriber queue
  await ws.close()
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
