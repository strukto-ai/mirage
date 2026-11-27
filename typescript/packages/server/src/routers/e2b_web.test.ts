import { MountMode } from '@struktoai/mirage-core/types'
import { RAMVFS } from '@struktoai/mirage-core/vfs/ram/ram'
import { Workspace } from '@struktoai/mirage-core/workspace/workspace/workspace'
import { afterEach, expect, it } from 'vitest'
import {
  checkSandboxAccess,
  dataRoutes,
  type LifecycleBackend,
  lifecycleRoutes,
  Sandbox,
  type SandboxRecord,
} from './e2b.ts'

const ORIGIN = 'http://sandbox.test'
const CONNECT_JSON = 'application/connect+json'

class FakeBackend implements LifecycleBackend {
  readonly records = new Map<string, SandboxRecord>()
  readonly workspaces = new Map<string, Workspace>()
  readonly sandboxes = new Map<string, Sandbox>()

  get(sandboxId: string): Promise<SandboxRecord | null> {
    return Promise.resolve(this.records.get(sandboxId) ?? null)
  }

  put(record: SandboxRecord): Promise<void> {
    this.records.set(record.sandboxId, record)
    return Promise.resolve()
  }

  delete(sandboxId: string): Promise<void> {
    this.records.delete(sandboxId)
    return Promise.resolve()
  }

  start(): Promise<string> {
    const workspaceId = `workspace-${String(this.workspaces.size + 1)}`
    this.workspaces.set(
      workspaceId,
      new Workspace({ '/home/user': new RAMVFS() }, { mode: MountMode.WRITE }),
    )
    return Promise.resolve(workspaceId)
  }

  async stop(workspaceId: string): Promise<void> {
    await this.sandboxes.get(workspaceId)?.stop()
    this.sandboxes.delete(workspaceId)
    await this.workspaces.get(workspaceId)?.close()
    this.workspaces.delete(workspaceId)
  }

  /** The sandbox `record` runs in, built on its first data request as a host does. */
  sandboxOf(record: SandboxRecord): Sandbox | undefined {
    const held = this.sandboxes.get(record.workspaceId)
    if (held !== undefined) return held
    const workspace = this.workspaces.get(record.workspaceId)
    if (workspace === undefined) return undefined
    const sandbox = new Sandbox(workspace, record.envVars)
    this.sandboxes.set(record.workspaceId, sandbox)
    return sandbox
  }
}

const stores: FakeBackend[] = []

afterEach(async () => {
  for (const store of stores.splice(0)) {
    await Promise.all([...store.workspaces.values()].map((ws) => ws.close()))
  }
})

/** Serve one data request as a host would: look the record up, check it, then run it. */
async function serve(store: FakeBackend, request: Request): Promise<Response> {
  const record = await store.get(request.headers.get('e2b-sandbox-id') ?? '')
  const refused = checkSandboxAccess(request, record)
  if (refused !== null) return refused
  const sandbox = record === null ? undefined : store.sandboxOf(record)
  if (sandbox === undefined) throw new Error('access check let a gone sandbox through')
  return dataRoutes(request, sandbox)
}

function sandboxHeaders(lease: { sandboxID: string; envdAccessToken: string }) {
  return {
    'e2b-sandbox-id': lease.sandboxID,
    'e2b-sandbox-port': '49983',
    'x-access-token': lease.envdAccessToken,
  }
}

function startFrame(line: string, stdin = false): Uint8Array<ArrayBuffer> {
  const payload = new TextEncoder().encode(
    JSON.stringify({ process: { cmd: '/bin/bash', args: ['-l', '-c', line] }, stdin }),
  )
  const frame = new Uint8Array(5 + payload.byteLength)
  new DataView(frame.buffer).setUint32(1, payload.byteLength)
  frame.set(payload, 5)
  return frame
}

interface Frame {
  flags: number
  payload: {
    event?: { start?: { pid: number }; data?: { stdout?: string }; end?: { exitCode: number } }
    error?: { code: string }
  }
}

function framesOf(body: Uint8Array): Frame[] {
  const frames: Frame[] = []
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength)
  for (let offset = 0; offset < body.byteLength;) {
    const end = offset + 5 + view.getUint32(offset + 1)
    frames.push({
      flags: view.getUint8(offset),
      payload: JSON.parse(
        new TextDecoder().decode(body.subarray(offset + 5, end)),
      ) as Frame['payload'],
    })
    offset = end
  }
  return frames
}

it('serves create, a command, a stat and health through web requests only', async () => {
  const store = new FakeBackend()
  stores.push(store)
  const lifecycle = lifecycleRoutes(store)

  const created = await lifecycle(
    new Request(`${ORIGIN}/v2/sandboxes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ timeout: 60, envVars: { GREETING: 'hello' } }),
    }),
    'alice',
  )
  expect(created.status).toBe(201)
  const sandbox = (await created.json()) as { sandboxID: string; envdAccessToken: string }
  expect(store.records.get(sandbox.sandboxID)?.owner).toBe('alice')
  const headers = sandboxHeaders(sandbox)

  const health = await serve(store, new Request(`${ORIGIN}/health`, { headers }))
  expect(health.status).toBe(204)

  const command = await serve(
    store,
    new Request(`${ORIGIN}/process.Process/Start`, {
      method: 'POST',
      headers: { ...headers, 'content-type': CONNECT_JSON },
      body: startFrame('printf %s "$GREETING" > greeting.txt && cat greeting.txt'),
    }),
  )
  expect(command.status).toBe(200)
  expect(command.headers.get('content-type')).toBe(CONNECT_JSON)
  const frames = framesOf(new Uint8Array(await command.arrayBuffer()))
  const stdout = frames
    .map((frame) => frame.payload.event?.data?.stdout)
    .filter((chunk) => chunk !== undefined)
    .map((chunk) => atob(chunk))
    .join('')
  expect(stdout).toBe('hello')
  expect(frames.at(-2)?.payload.event?.end?.exitCode).toBe(0)
  expect(frames.at(-1)).toEqual({ flags: 2, payload: {} })

  const stat = await serve(
    store,
    new Request(`${ORIGIN}/filesystem.Filesystem/Stat`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'greeting.txt' }),
    }),
  )
  expect(stat.status).toBe(200)
  expect(await stat.json()).toMatchObject({
    entry: { name: 'greeting.txt', type: 'FILE_TYPE_FILE', path: '/home/user/greeting.txt' },
  })

  const missing = await serve(
    store,
    new Request(`${ORIGIN}/health`, { headers: { ...headers, 'e2b-sandbox-id': 'missing' } }),
  )
  expect(missing.status).toBe(502)

  const forged = await serve(
    store,
    new Request(`${ORIGIN}/filesystem.Filesystem/Stat`, {
      method: 'POST',
      headers: { ...headers, 'x-access-token': 'forged', 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'greeting.txt' }),
    }),
  )
  expect(forged.status).toBe(401)
  expect(await forged.json()).toMatchObject({ code: 'unauthenticated' })

  const raw = await lifecycle(
    new Request(`${ORIGIN}/v2/sandboxes`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array([1]),
    }),
    'alice',
  )
  expect(raw.status).toBe(400)
  expect(raw.headers.has('connection')).toBe(false)
})

it('cancels a running command and refuses file work once the host stops the sandbox', async () => {
  const store = new FakeBackend()
  stores.push(store)
  const created = await lifecycleRoutes(store)(
    new Request(`${ORIGIN}/v2/sandboxes`, { method: 'POST' }),
    'alice',
  )
  const headers = sandboxHeaders(
    (await created.json()) as { sandboxID: string; envdAccessToken: string },
  )
  const command = await serve(
    store,
    new Request(`${ORIGIN}/process.Process/Start`, {
      method: 'POST',
      headers: { ...headers, 'content-type': CONNECT_JSON },
      body: startFrame('cat', true),
    }),
  )
  expect(command.status).toBe(200)
  const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = command.body?.getReader()
  if (reader === undefined) throw new Error('command answered without a stream')
  const chunks: Uint8Array[] = []
  const first = await reader.read()
  if (first.value !== undefined) chunks.push(first.value)
  expect(framesOf(chunks[0] ?? new Uint8Array()).at(0)?.payload.event?.start).toBeDefined()
  await store.sandboxes.get(headers['e2b-sandbox-id'])?.stop()
  for (let next = await reader.read(); !next.done; next = await reader.read()) {
    chunks.push(next.value)
  }
  const body = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0))
  chunks.reduce((at, chunk) => {
    body.set(chunk, at)
    return at + chunk.byteLength
  }, 0)
  expect(framesOf(body).at(-1)).toEqual({
    flags: 2,
    payload: { error: { code: 'canceled', message: 'command canceled' } },
  })

  const stat = await serve(
    store,
    new Request(`${ORIGIN}/filesystem.Filesystem/Stat`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ path: '.' }),
    }),
  )
  expect(stat.status).toBe(401)
  expect(await stat.json()).toMatchObject({ code: 'unauthenticated' })
})
