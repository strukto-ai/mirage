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

import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import {
  FileChangeKind,
  MountMode,
  NextcloudEventHook,
  NextcloudVFS,
  PathSpec,
  Workspace,
  type NextcloudConfig,
} from '@struktoai/mirage-node'
import type { JsonValue } from '@struktoai/mirage-core/types'

const __HERE = fileURLToPath(new URL('.', import.meta.url))
dotenv.config({ path: resolve(__HERE, '../../../../.env.development'), override: true })

const MOUNT = '/nc'
// Docker Desktop forwards host.docker.internal to this loopback address;
// where it does not (Linux), set WEBHOOK_HOST to an address the Nextcloud
// container can reach.
const HOST = process.env.WEBHOOK_HOST ?? '127.0.0.1'
const PORT = Number.parseInt(process.env.WEBHOOK_PORT ?? '8990', 10)
const AUTH_HEADER = 'X-Webhook-Secret'

// The webhook_listeners event classes to register a webhook for.
const EVENT_CLASSES = [
  'OCP\\Files\\Events\\Node\\NodeCreatedEvent',
  'OCP\\Files\\Events\\Node\\NodeWrittenEvent',
  'OCP\\Files\\Events\\Node\\NodeDeletedEvent',
  'OCP\\Files\\Events\\Node\\NodeRenamedEvent',
]

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') {
    throw new Error(`${name} env var is required`)
  }
  return value
}

/** A header's raw bytes when it was sent exactly once, else empty. */
function header(request: IncomingMessage, name: string): Buffer {
  const values = request.headersDistinct[name.toLowerCase()] ?? []
  if (values.length !== 1) return Buffer.alloc(0)
  return Buffer.from(values[0] ?? '', 'latin1')
}

function sameBytes(given: Buffer, expected: Buffer): boolean {
  return given.length === expected.length && timingSafeEqual(given, expected)
}

// Python's shlex.quote, so the commands match the Python example.
function shellQuote(value: string): string {
  if (value === '') return "''"
  if (/^[\w@%+=:,./-]+$/.test(value)) return value
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

const SECRET = Buffer.from(requiredEnv('NEXTCLOUD_WEBHOOK_SECRET'), 'utf8')

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

/**
 * The consumer-owned push endpoint: Nextcloud POSTs here.
 *
 * Mirage hosts no server; this receiver lives in your own service and
 * just imports mirage. A delivery must carry the shared secret in
 * `X-Webhook-Secret`; any other is refused before its body is read.
 * `NextcloudEventHook` maps each delivery onto the mount, and every
 * change goes to ws.notify. No polling anywhere, no setup call: the
 * event runtime attaches lazily on first use.
 */
class WebhookReceiver {
  private readonly hook = new NextcloudEventHook(vfs.accessor)
  private readonly root = PathSpec.fromStrPath(MOUNT, '')

  constructor(private readonly workspace: Workspace) {}

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!sameBytes(header(request, AUTH_HEADER), SECRET)) {
      response.writeHead(401, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ ok: false }))
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as JsonValue
    const event = isObject(payload) ? payload.event : undefined
    const eventClass = isObject(event) && typeof event.class === 'string' ? event.class : ''
    for (const change of await this.hook.toEvents(this.root, eventClass, payload)) {
      console.log(`webhook: ${change.kind} ${change.path.virtual}`)
      await this.workspace.notify(change)
    }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ ok: true }))
  }
}

function isObject(value: JsonValue | undefined): value is { [k: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Print the one-time Nextcloud setup for push delivery. */
function printRegistrationHelp(): void {
  const callback =
    process.env.WEBHOOK_CALLBACK ?? `http://host.docker.internal:${String(PORT)}/nextcloud/webhook`
  const base = config.url.split('/remote.php')[0]
  console.log('One-time Nextcloud setup (admin):')
  console.log('  1. Enable the app:  occ app:enable webhook_listeners')
  console.log('  2. Register one webhook per event class, e.g.:')
  for (const cls of EVENT_CLASSES) {
    const escaped = cls.replaceAll('\\', '\\\\')
    console.log(
      `     curl -u ${String(config.username)}:*** -H "OCS-APIRequest: true"` +
        ' -H "Content-Type: application/json"' +
        ` -X POST ${String(base)}/ocs/v2.php/apps/webhook_listeners` +
        '/api/v1/webhooks' +
        ` -d '{"httpMethod": "POST", "uri": "${callback}",` +
        ` "event": "${escaped}", "authMethod": "header",` +
        ` "authData": {"${AUTH_HEADER}": "***"}}'`,
    )
  }
  console.log(
    '     (*** in authData is NEXTCLOUD_WEBHOOK_SECRET: Nextcloud sends' +
      ` it as ${AUTH_HEADER}, and the receiver refuses a delivery` +
      ' without it.)',
  )
  console.log(
    '  3. Delivery rides Nextcloud background jobs; with the docker' +
      ' image run `occ background:cron` (or enable system cron) so' +
      ' events flush promptly.\n',
  )
}

async function main(): Promise<void> {
  const receiver = new WebhookReceiver(ws)
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/nextcloud/webhook') {
      response.writeHead(404).end()
      return
    }
    receiver.handle(request, response).catch((err: unknown) => {
      console.error(err)
      response.writeHead(500).end()
    })
  })
  await new Promise<void>((done) => server.listen(PORT, HOST, done))
  console.log(`consumer receiver listening on ${HOST}:${String(PORT)}/nextcloud/webhook\n`)
  printRegistrationHelp()

  // Ctrl-C closes the event runtime, which ends the loop below cleanly.
  process.once('SIGINT', () => {
    void ws.detachEventRuntime()
  })

  console.log(
    `listening on ${MOUNT}: create/edit/delete files in the Nextcloud` +
      ' UI, changes stream here (Ctrl-C to stop):\n',
  )
  try {
    for await (const change of ws.events(PathSpec.fromStrPath(MOUNT))) {
      console.log(`event: ${change.kind} ${change.path.virtual}`)
      if (change.kind !== FileChangeKind.DELETE) {
        const result = await ws.shell(`head -c 200 ${shellQuote(change.path.virtual)}`)
        const fresh = result.stdoutText.trim()
        console.log(`  fresh content: ${JSON.stringify(fresh.slice(0, 80))}`)
      }
    }
  } finally {
    const closed = new Promise<void>((done) => server.close(() => done()))
    server.closeAllConnections()
    await closed
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
