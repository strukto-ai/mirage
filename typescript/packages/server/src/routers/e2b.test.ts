import { Buffer } from 'node:buffer'
import { generateKeyPairSync } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { Agent, request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buffer } from 'node:stream/consumers'
import { memoryResourceStore } from '@struktoai/mirage-core/resources/memory'
import { RAMWorkspaceStateStore } from '@struktoai/mirage-core/workspace/store/ram'
import { DiskRecordClient, DiskWorkspaceStateStore } from '@struktoai/mirage-node'
import { SignJWT } from 'jose'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildApp, type BuildAppOptions, type MirageApp } from '../app.ts'
import { AuthMode, type AuthConfig } from '../auth/config.ts'
import { SandboxFiles } from '../e2b/files.ts'
import { CONNECT_STREAM } from '../e2b/process.ts'
import { CONFIGS_PREFIX, OWNERS_PREFIX } from '../registry.ts'

const API_KEY = { 'x-api-key': 'test-key' }
const BEARER = { authorization: 'Bearer test-key' }
const RAM = { mounts: { '/home/user': { vfs: 'ram', mode: 'write' } } }
const CREATE = '/v2/sandboxes'
const START = '/process.Process/Start'
const HEALTH = '/health'

interface SandboxResponse {
  sandboxID: string
  templateID: string
  clientID: string
  envdVersion: string
  envdAccessToken: string
}

const applications: MirageApp[] = []
const stateRoots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  for (const app of applications.splice(0)) await app.close()
  for (const path of stateRoots.splice(0)) await rm(path, { recursive: true, force: true })
})

async function setup(options: BuildAppOptions = {}, useApprovedTemplate = true) {
  const stateRoot = options.stateRoot ?? (await mkdtemp(join(tmpdir(), 'mirage-e2b-')))
  if (options.stateRoot === undefined) stateRoots.push(stateRoot)
  const templateRoot = join(stateRoot, 'template-state')
  const resourceStore = options.resourceStore ?? memoryResourceStore()
  if (useApprovedTemplate) {
    await resourceStore.createTemplate({
      name: 'approved',
      description: null,
      config: { ...RAM, store: { type: 'disk', root: templateRoot } },
    })
  }
  const app = buildApp({
    authConfig: { mode: AuthMode.Token, bearerToken: API_KEY['x-api-key'] },
    ...(useApprovedTemplate ? { e2bTemplate: 'approved' } : {}),
    rateLimits: [],
    stateRoot,
    resourceStore,
    ...options,
  })
  applications.push(app)
  return { app, stateRoot, templateRoot }
}

async function create(
  app: MirageApp,
  payload: Record<string, unknown> = {},
  headers = API_KEY,
): Promise<SandboxResponse> {
  const reply = await app.inject({ method: 'POST', url: CREATE, headers, payload })
  expect(reply.statusCode, reply.body).toBe(201)
  return reply.json<SandboxResponse>()
}

function connect(app: MirageApp, id: string, timeout: number, headers = API_KEY) {
  return app.inject({
    method: 'POST',
    url: `${CREATE}/${id}/connect`,
    payload: { timeout },
    headers,
  })
}

function setSandboxTimeout(app: MirageApp, id: string, timeout: number, headers = API_KEY) {
  return app.inject({
    method: 'POST',
    url: `/sandboxes/${id}/timeout`,
    payload: { timeout },
    headers,
  })
}

function kill(app: MirageApp, id: string, headers = API_KEY) {
  return app.inject({ method: 'DELETE', url: `/sandboxes/${id}`, headers })
}

function dataHeaders(sandbox: SandboxResponse): Record<string, string> {
  return {
    'e2b-sandbox-id': sandbox.sandboxID,
    'e2b-sandbox-port': '49983',
    'x-access-token': sandbox.envdAccessToken,
    'content-type': CONNECT_STREAM,
    authorization: 'Basic dXNlcjo=',
  }
}

function processBody(
  line: string,
  options: { cwd?: string; envs?: Record<string, string> } = {},
): Buffer<ArrayBuffer> {
  const payload = Buffer.from(
    JSON.stringify({ process: { cmd: '/bin/bash', args: ['-l', '-c', line], ...options } }),
  )
  const frame = Buffer.alloc(5 + payload.length)
  frame.writeUInt32BE(payload.length, 1)
  payload.copy(frame, 5)
  return frame
}

function streamingPost(url: string, headers: Record<string, string>, agent?: Agent) {
  const client = request(url, { method: 'POST', headers, agent })
  client.setTimeout(3000, () => client.destroy(new Error('streaming request timed out')))
  const reply = new Promise<{
    status: number | undefined
    connection: string | undefined
    body: Buffer
  }>((resolve, reject) => {
    client.once('error', reject)
    client.once('response', (response) => {
      void buffer(response).then(
        (body) => {
          resolve({
            status: response.statusCode,
            connection: response.headers.connection,
            body,
          })
        },
        (error: unknown) => {
          reject(error instanceof Error ? error : new Error(String(error)))
        },
      )
    })
  })
  return { client, reply }
}

interface ProcessFrame {
  flags: number
  payload: {
    event?: {
      start?: { pid: number }
      data?: { stdout?: string; stderr?: string }
      end?: { exitCode: number; exited: boolean; status: string }
    }
    error?: { code: string; message: string }
  }
}

function processFrames(body: Buffer): ProcessFrame[] {
  const frames: ProcessFrame[] = []
  for (let offset = 0; offset < body.length;) {
    const end = offset + 5 + body.readUInt32BE(offset + 1)
    frames.push({
      flags: body.readUInt8(offset),
      payload: JSON.parse(body.subarray(offset + 5, end).toString()) as ProcessFrame['payload'],
    })
    offset = end
  }
  return frames
}

function processOutput(frames: ProcessFrame[], stream: 'stdout' | 'stderr'): string {
  return Buffer.concat(
    frames.flatMap(({ payload }) => {
      const value = payload.event?.data?.[stream]
      return value === undefined ? [] : [Buffer.from(value, 'base64')]
    }),
  ).toString()
}

async function runCommand(
  app: MirageApp,
  headers: Record<string, string>,
  body: Buffer,
): Promise<ProcessFrame[]> {
  const answer = await app.inject({ method: 'POST', url: START, headers, payload: body })
  expect(answer.statusCode, answer.body).toBe(200)
  expect(answer.headers['content-type']).toBe(CONNECT_STREAM)
  return processFrames(answer.rawPayload)
}

describe('E2B lifecycle', () => {
  it('requires an actual API key and allows explicitly disabling the routes', async () => {
    vi.stubEnv('MIRAGE_E2B_TEMPLATE', 'approved')
    const { app: disabled } = await setup({ e2bTemplate: '' })
    expect(
      (await disabled.inject({ method: 'POST', url: CREATE, headers: BEARER })).statusCode,
    ).toBe(404)
    expect((await disabled.inject({ url: HEALTH, headers: BEARER })).statusCode).toBe(404)

    vi.stubEnv('MIRAGE_E2B_TEMPLATE', undefined)
    const { app: noCredential } = await setup({ authConfig: { mode: AuthMode.Local } }, false)
    const local = await noCredential.inject({ method: 'POST', url: CREATE, headers: API_KEY })
    expect(local.statusCode).toBe(401)
    expect(local.json()).toEqual({ code: 401, message: 'unauthorized' })

    const { app } = await setup({}, false)
    for (const headers of [{}, BEARER, { 'x-api-key': 'incorrect' }]) {
      const refused = await app.inject({ method: 'POST', url: CREATE, headers })
      expect(refused.statusCode).toBe(401)
      expect(refused.json()).toEqual({ code: 401, message: 'unauthorized' })
    }
    expect((await app.inject({ url: CREATE, headers: API_KEY })).statusCode).toBe(501)
    expect((await app.inject({ url: '/v1/workspaces', headers: API_KEY })).statusCode).toBe(401)
    expect((await app.inject({ url: '/v1/workspaces', headers: BEARER })).statusCode).toBe(200)
  })

  it.each([undefined, '  '])(
    'creates fresh writable base sandboxes with template env %j',
    async (env) => {
      vi.stubEnv('MIRAGE_E2B_TEMPLATE', env)
      const resourceStore = memoryResourceStore()
      if (env !== undefined) {
        await resourceStore.createTemplate({
          name: 'base',
          description: null,
          config: { mounts: { '/other': { vfs: 'ram' } } },
        })
      }
      const { app } = await setup({ resourceStore }, false)
      const first = await create(app)
      expect(first.templateID).toBe('base')
      const reconnected = await connect(app, first.sandboxID, 300)
      expect(reconnected.statusCode).toBe(200)
      expect(reconnected.json()).toEqual(first)
      const detail = await app.inject({ url: `/v1/workspaces/${first.sandboxID}`, headers: BEARER })
      expect(detail.statusCode, detail.body).toBe(200)
      expect(detail.json()).toMatchObject({
        mounts: [
          { prefix: '/home/user/', vfs: 'ram', mode: 'write' },
          { prefix: '/', vfs: 'ram', mode: 'read' },
        ],
      })
      const headers = dataHeaders(first)
      const written = await runCommand(app, headers, processBody('printf kept > state.txt'))
      expect(written.at(-2)?.payload.event?.end?.exitCode).toBe(0)
      const url = '/files?path=state.txt'
      const stored = await app.inject({ url, headers })
      expect(stored.statusCode).toBe(200)
      expect(stored.body).toBe('kept')

      const second = await create(app, { templateID: 'base' })
      expect(second.templateID).toBe('base')
      expect(second.sandboxID).not.toBe(first.sandboxID)
      expect((await app.inject({ url, headers: dataHeaders(second) })).statusCode).toBe(404)
    },
  )

  it('uses the configured saved template and reports it missing when absent', async () => {
    vi.stubEnv('MIRAGE_E2B_TEMPLATE', ' approved ')
    const resourceStore = memoryResourceStore()
    await resourceStore.createTemplate({ name: 'approved', description: null, config: RAM })
    const { app } = await setup({ resourceStore }, false)
    expect((await create(app)).templateID).toBe('approved')
    const { app: empty } = await setup({}, false)
    const missing = await empty.inject({ method: 'POST', url: CREATE, headers: API_KEY })
    expect(missing.statusCode).toBe(404)
    expect(missing.json()).toMatchObject({ code: 404 })
  })

  it('maps the approved aliases, validates input, and returns the same lease on connect', async () => {
    const { app } = await setup({ maxWorkspaces: 1 })
    const unknown = await app.inject({
      method: 'POST',
      url: CREATE,
      headers: API_KEY,
      payload: { templateID: 'unknown' },
    })
    expect(unknown.statusCode).toBe(404)
    expect(unknown.json()).toMatchObject({ code: 404 })
    for (const payload of [
      { timeout: 0 },
      { timeout: -1 },
      { timeout: 1.5 },
      { envVars: { VALUE: 1 } },
    ]) {
      const invalid = await app.inject({ method: 'POST', url: CREATE, headers: API_KEY, payload })
      expect(invalid.statusCode).toBe(400)
      expect(invalid.json()).toMatchObject({ code: 400 })
    }
    const invalidJson = await app.inject({
      method: 'POST',
      url: CREATE,
      headers: { ...API_KEY, 'content-type': 'application/json' },
      payload: '{',
    })
    expect(invalidJson.statusCode).toBe(400)
    expect(invalidJson.json()).toMatchObject({ code: 400 })

    const first = await create(app, { templateID: 'base', envVars: { VALUE: '1' } })
    expect(first.sandboxID).toMatch(/^[0-9a-f-]+$/)
    expect(first.clientID).toBe(first.sandboxID)
    expect(first.templateID).toBe('approved')
    expect(first.envdVersion).toBe('0.5.6')
    expect(first.envdAccessToken).toMatch(/^[0-9a-f]{64}$/)
    const reconnected = await connect(app, first.sandboxID, 300)
    expect(reconnected.statusCode).toBe(200)
    expect(reconnected.json()).toEqual(first)
    expect((await connect(app, first.sandboxID, 0)).statusCode).toBe(400)
    const full = await app.inject({ method: 'POST', url: CREATE, headers: API_KEY, payload: {} })
    expect(full.statusCode).toBe(503)
    expect(full.json()).toMatchObject({ code: 503 })

    expect((await kill(app, first.sandboxID)).statusCode).toBe(204)
    expect((await kill(app, first.sandboxID)).statusCode).toBe(404)
    expect((await connect(app, first.sandboxID, 300)).statusCode).toBe(404)
    const second = await create(app, { templateID: 'approved' })
    expect(second.envdAccessToken).not.toBe(first.envdAccessToken)
  })

  it('keeps the authenticated owner and creates no durable workspace state or claim', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const authConfig: AuthConfig = {
      mode: AuthMode.Jwt,
      jwt: {
        algorithm: 'RS256',
        key: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        audiences: [],
        authorizedParties: [],
        clockSkewSeconds: 0,
      },
    }
    const keyFor = async (owner: string) => ({
      'x-api-key': await new SignJWT({})
        .setSubject(owner)
        .setExpirationTime('1m')
        .setProtectedHeader({ alg: 'RS256' })
        .sign(privateKey),
    })
    const { app, stateRoot, templateRoot } = await setup({ authConfig })
    const owner = await keyFor('owner')
    const other = await keyFor('other')
    const { sandboxID: id } = await create(app, {}, owner)
    const entry = app.registry.get(id)
    expect(entry.owner).toBe('owner')
    expect(entry.runner.ws.stateStore).toBeInstanceOf(RAMWorkspaceStateStore)
    expect((await connect(app, id, 300, other)).statusCode).toBe(404)
    expect((await setSandboxTimeout(app, id, 300, other)).statusCode).toBe(404)
    expect((await kill(app, id, other)).statusCode).toBe(404)
    expect((await connect(app, id, 300, owner)).statusCode).toBe(200)
    for (const prefix of [OWNERS_PREFIX, CONFIGS_PREFIX]) {
      const [record] = await new DiskRecordClient(stateRoot, prefix).get(id)
      expect(record).toBeNull()
    }
    for (const root of [stateRoot, templateRoot]) {
      const store = new DiskWorkspaceStateStore({ root })
      try {
        expect(await store.loadMeta(id)).toBeNull()
      } finally {
        await store.close()
      }
    }
    await app.close()
    const { app: restarted } = await setup({ stateRoot, authConfig })
    expect((await connect(restarted, id, 300, owner)).statusCode).toBe(404)
    expect(
      (
        await restarted.inject({
          method: 'POST',
          url: `/v1/workspaces/${id}/start`,
          headers: { authorization: `Bearer ${owner['x-api-key']}` },
        })
      ).statusCode,
    ).toBe(404)
  })

  it('extends a live lease, never shortens it on reconnect, and cleans it up on expiry', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const { app } = await setup()
    const { sandboxID: id } = await create(app, { timeout: 1 })
    await vi.advanceTimersByTimeAsync(500)
    expect((await connect(app, id, 3)).statusCode).toBe(200)
    await vi.advanceTimersByTimeAsync(500)
    expect((await connect(app, id, 1)).statusCode).toBe(200)
    await vi.advanceTimersByTimeAsync(1500)
    expect(app.registry.has(id)).toBe(true)
    await vi.advanceTimersByTimeAsync(1100)
    expect(app.registry.has(id)).toBe(false)
    expect((await connect(app, id, 300)).statusCode).toBe(404)
    expect((await kill(app, id)).statusCode).toBe(404)
  })

  it('authenticates and validates timeout requests', async () => {
    const { app } = await setup()
    const { sandboxID: id } = await create(app)
    const url = `/sandboxes/${id}/timeout`
    for (const headers of [{}, BEARER, { 'x-api-key': 'incorrect' }]) {
      const refused = await app.inject({ method: 'POST', url, headers, payload: { timeout: 10 } })
      expect(refused.statusCode).toBe(401)
      expect(refused.json()).toMatchObject({ code: 401 })
    }
    for (const payload of [
      {},
      { timeout: null },
      { timeout: true },
      { timeout: '1' },
      { timeout: 1.5 },
      { timeout: -1 },
      { timeout: 2 ** 31 },
    ]) {
      const invalid = await app.inject({ method: 'POST', url, payload, headers: API_KEY })
      expect(invalid.statusCode).toBe(400)
      expect(invalid.json()).toMatchObject({ code: 400 })
    }
    expect((await setSandboxTimeout(app, 'missing', 1)).statusCode).toBe(404)
    expect((await setSandboxTimeout(app, id, 2 ** 31 - 1)).statusCode).toBe(204)
  })

  it('resets the deadline later and earlier while keeping the sandbox and its files', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const { app } = await setup()
    const sandbox = await create(app, { timeout: 1 })
    const id = sandbox.sandboxID
    const headers = dataHeaders(sandbox)
    const prepared = await runCommand(app, headers, processBody('printf kept > state.txt'))
    expect(prepared.at(-2)?.payload.event?.end?.exitCode).toBe(0)

    await vi.advanceTimersByTimeAsync(500)
    const extended = await setSandboxTimeout(app, id, 5)
    expect(extended.statusCode).toBe(204)
    expect(extended.body).toBe('')
    await vi.advanceTimersByTimeAsync(1000)
    const file = await app.inject({ url: '/files?path=state.txt', headers })
    expect(file.statusCode).toBe(200)
    expect(file.body).toBe('kept')

    expect((await setSandboxTimeout(app, id, 2)).statusCode).toBe(204)
    await vi.advanceTimersByTimeAsync(1999)
    expect((await app.inject({ url: HEALTH, headers })).statusCode).toBe(204)
    await vi.advanceTimersByTimeAsync(1)
    expect((await app.inject({ url: HEALTH, headers })).statusCode).toBe(502)
    expect((await setSandboxTimeout(app, id, 5)).statusCode).toBe(404)
  })

  it('revokes access immediately on a zero timeout and cleans up the workspace', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const { app } = await setup()
    const sandbox = await create(app)
    const headers = dataHeaders(sandbox)
    const id = sandbox.sandboxID

    expect((await setSandboxTimeout(app, id, 0)).statusCode).toBe(204)
    expect((await app.inject({ url: HEALTH, headers })).statusCode).toBe(502)
    expect((await app.inject({ url: '/files?path=state.txt', headers })).statusCode).toBe(401)
    expect((await connect(app, id, 300)).statusCode).toBe(404)
    await vi.advanceTimersByTimeAsync(1)
    expect(app.registry.has(id)).toBe(false)
  })

  it('revokes a lease when its workspace is stopped through the native API', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const { app } = await setup()
    const timers = vi.spyOn(globalThis, 'setTimeout')
    const cleared = vi.spyOn(globalThis, 'clearTimeout')
    const { sandboxID: id } = await create(app, { timeout: 600 })
    const timer = timers.mock.results[timers.mock.calls.findIndex(([, delay]) => delay === 600_000)]
    if (timer?.type !== 'return') throw new Error('sandbox expiry was not scheduled')
    const stopped = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${id}/stop`,
      headers: BEARER,
    })
    expect(stopped.statusCode).toBe(200)
    expect(cleared).toHaveBeenCalledWith(timer.value)
    expect((await connect(app, id, 300)).statusCode).toBe(404)
    expect((await kill(app, id)).statusCode).toBe(404)
  })
})

describe('E2B health', () => {
  it('requires routing headers and the live sandbox token', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const { app } = await setup()
    const sandbox = await create(app, { timeout: 1 })
    const routing = {
      'e2b-sandbox-id': sandbox.sandboxID,
      'e2b-sandbox-port': '49983',
    }
    const headers = { ...routing, 'x-access-token': sandbox.envdAccessToken }
    const health = (headers: Record<string, string>) => app.inject({ url: HEALTH, headers })

    for (const malformed of [
      { ...headers, 'e2b-sandbox-id': '' },
      { ...headers, 'e2b-sandbox-port': '49999' },
    ]) {
      const refused = await health(malformed)
      expect(refused.statusCode).toBe(400)
      expect(refused.json()).toMatchObject({ code: 400 })
    }
    for (const unauthorized of [
      { ...routing, ...API_KEY },
      { ...headers, 'x-access-token': '' },
      { ...headers, 'x-access-token': 'incorrect' },
    ]) {
      const refused = await health(unauthorized)
      expect(refused.statusCode).toBe(502)
    }
    const active = await health(headers)
    expect(active.statusCode).toBe(204)
    expect(active.body).toBe('')
    expect((await health({ ...headers, 'e2b-sandbox-id': 'missing' })).statusCode).toBe(502)

    await vi.advanceTimersByTimeAsync(1000)
    expect((await health(headers)).statusCode).toBe(502)
    expect((await health(routing)).statusCode).toBe(502)
  })
})

describe('E2B commands', () => {
  it('streams both outputs and the exit status with per-call cwd and env', async () => {
    const { app } = await setup()
    const sandbox = await create(app, { envVars: { CHECK: 'lease', OTHER: 'shared' } })
    const headers = dataHeaders(sandbox)
    const first = await runCommand(
      app,
      headers,
      processBody(
        'pwd; printf "%s" "$CHECK:$OTHER"; printf "warning" >&2; cd /; export CHECK=changed; exit 7',
        { envs: { CHECK: 'request' } },
      ),
    )
    expect(first[0]?.flags).toBe(0)
    expect(first[0]?.payload.event?.start?.pid).toBeGreaterThan(0)
    expect(processOutput(first, 'stdout')).toBe('/home/user\nrequest:shared')
    expect(processOutput(first, 'stderr')).toBe('warning')
    expect(first.at(-2)).toEqual({
      flags: 0,
      payload: { event: { end: { exitCode: 7, exited: true, status: 'exited' } } },
    })
    expect(first.at(-1)).toEqual({ flags: 2, payload: {} })

    const second = await runCommand(app, headers, processBody('pwd; printf "%s" "$CHECK"'))
    expect(second[0]?.payload.event?.start?.pid).not.toBe(first[0]?.payload.event?.start?.pid)
    expect(processOutput(second, 'stdout')).toBe('/home/user\nlease')
    const override = await runCommand(app, headers, processBody('pwd', { cwd: '/' }))
    expect(processOutput(override, 'stdout')).toBe('/\n')
  })

  it('uses the workspace command policy and preserves the denied exit status', async () => {
    const { app } = await setup({
      policies: [
        {
          preCommand: ({ command }) =>
            command === 'touch' ? { kind: 'deny', reason: 'no touch' } : null,
        },
      ],
    })
    const sandbox = await create(app)
    const denied = await runCommand(app, dataHeaders(sandbox), processBody('touch denied'))
    expect(denied.at(-2)?.payload.event?.end?.exitCode).toBe(126)
    expect(processOutput(denied, 'stderr')).toBe('touch: Permission denied\n')
  })

  it('requires a live lease token for this sandbox and the envd port', async () => {
    const { app } = await setup()
    const first = await create(app)
    const second = await create(app)
    const post = (headers: Record<string, string>, payload: Buffer = processBody('pwd')) =>
      app.inject({ method: 'POST', url: START, headers, payload })
    const firstHeaders = dataHeaders(first)
    const wrongPort = await post({ ...firstHeaders, 'e2b-sandbox-port': '49999' })
    expect(wrongPort.statusCode).toBe(400)
    expect(wrongPort.json()).toMatchObject({ code: 'invalid_argument' })
    for (const token of ['', second.envdAccessToken, API_KEY['x-api-key']]) {
      const refused = await post({ ...firstHeaders, ...BEARER, 'x-access-token': token })
      expect(refused.statusCode).toBe(401)
      expect(refused.json()).toMatchObject({ code: 'unauthenticated' })
    }
    const malformed = await post(firstHeaders, Buffer.from('not a frame'))
    expect(malformed.statusCode).toBe(400)
    const badTimeout = await post({ ...firstHeaders, 'connect-timeout-ms': '1.5' })
    expect(badTimeout.statusCode).toBe(400)
    expect(
      (
        await app.inject({
          url: '/v1/workspaces',
          headers: { authorization: `Bearer ${first.envdAccessToken}` },
        })
      ).statusCode,
    ).toBe(401)
    expect((await kill(app, first.sandboxID)).statusCode).toBe(204)
    expect((await post(firstHeaders)).statusCode).toBe(401)
  })

  it('cancels a command at its Connect deadline before it can write', async () => {
    const { app } = await setup()
    const sandbox = await create(app)
    const headers = dataHeaders(sandbox)
    const timedOut = await runCommand(
      app,
      { ...headers, 'connect-timeout-ms': '25' },
      processBody('sleep 0.3; touch late'),
    )
    expect(timedOut.at(-1)).toEqual({
      flags: 2,
      payload: { error: { code: 'deadline_exceeded', message: 'command deadline exceeded' } },
    })
    const after = await runCommand(app, headers, processBody('test ! -e late'))
    expect(after.at(-2)?.payload.event?.end?.exitCode).toBe(0)
  })

  it('expires a Connect deadline while the request body is still uploading', async () => {
    const { app } = await setup()
    const headers = dataHeaders(await create(app))
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const { client, reply } = streamingPost(address + START, {
      ...headers,
      'connect-timeout-ms': '100',
    })
    try {
      client.write(processBody('touch expired').subarray(0, 4))
      const response = await reply
      expect(response.status).toBe(200)
      expect(response.connection).toBe('close')
      expect(processFrames(response.body)).toEqual([
        {
          flags: 2,
          payload: { error: { code: 'deadline_exceeded', message: 'command deadline exceeded' } },
        },
      ])
    } finally {
      client.destroy()
    }
    const after = await runCommand(app, headers, processBody('test ! -e expired'))
    expect(after.at(-2)?.payload.event?.end?.exitCode).toBe(0)
  })

  it('starts a command after a streamed request without a Connect timeout', async () => {
    const { app } = await setup()
    const headers = dataHeaders(await create(app))
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const { client, reply } = streamingPost(address + START, headers)
    const body = processBody('printf ready')
    client.write(body.subarray(0, 4))
    await new Promise((resolve) => setTimeout(resolve, 30))
    client.end(body.subarray(4))
    const response = await reply
    expect(response.status).toBe(200)
    const frames = processFrames(response.body)
    expect(processOutput(frames, 'stdout')).toBe('ready')
    expect(frames.at(-2)?.payload.event?.end?.exitCode).toBe(0)
  })

  it('uses only the remaining Connect deadline after reading the request', async () => {
    const { app } = await setup()
    const headers = dataHeaders(await create(app))
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const { client, reply } = streamingPost(address + START, {
      ...headers,
      'connect-timeout-ms': '1000',
    })
    const body = processBody('sleep 0.8; touch late')
    client.write(body.subarray(0, 4))
    await new Promise((resolve) => setTimeout(resolve, 400))
    client.end(body.subarray(4))
    const response = await reply
    expect(response.status).toBe(200)
    const frames = processFrames(response.body)
    expect(frames[0]?.payload.event?.start).toBeDefined()
    expect(frames.at(-1)?.payload.error?.code).toBe('deadline_exceeded')
    const after = await runCommand(app, headers, processBody('test ! -e late'))
    expect(after.at(-2)?.payload.event?.end?.exitCode).toBe(0)
  })

  it('streams output before completion and cancels the running line on disconnect', async () => {
    const { app } = await setup()
    const sandbox = await create(app)
    const headers = dataHeaders(sandbox)
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const stop = new AbortController()
    const response = await fetch(`${address}${START}`, {
      method: 'POST',
      headers,
      body: processBody('printf started; sleep 0.5; touch disconnected'),
      signal: stop.signal,
    })
    const reader = response.body?.getReader()
    if (reader === undefined) throw new Error('command response has no body')
    const decoder = new TextDecoder()
    let output = ''
    try {
      while (!output.includes('c3RhcnRlZA==')) {
        const received = await reader.read()
        if (received.done) throw new Error('command did not stream the first data frame')
        if (!(received.value instanceof Uint8Array)) throw new Error('unexpected response data')
        output += decoder.decode(received.value, { stream: true })
      }
      expect(output).not.toContain('"exited"')
    } finally {
      stop.abort()
      await reader.cancel().catch((error: unknown) => {
        if (!(error instanceof Error) || error.name !== 'AbortError') throw error
      })
    }
    await new Promise((resolve) => setTimeout(resolve, 600))
    const after = await runCommand(app, headers, processBody('test ! -e disconnected'))
    expect(after.at(-2)?.payload.event?.end?.exitCode).toBe(0)
  })
})

describe('E2B files', () => {
  it('aborts a download and closes its reader before shutdown stops the workspace', async () => {
    const { app } = await setup()
    const sandbox = await create(app)
    const entry = app.registry.get(sandbox.sandboxID)
    const stop = vi.spyOn(entry.runner, 'stop')
    const signal = AbortSignal.timeout(3_000)
    let reachedPull = (): void => undefined
    const pulling = new Promise<void>((resolve) => {
      reachedPull = resolve
    })
    let release = (): void => undefined
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    let sourceClosed = false
    async function* source(): AsyncGenerator<Uint8Array> {
      try {
        yield Buffer.from('first')
        reachedPull()
        await pending
        yield Buffer.from('second')
      } finally {
        sourceClosed = true
      }
    }
    vi.spyOn(SandboxFiles.prototype, 'read').mockResolvedValue(source())
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    try {
      const response = await fetch(`${address}/files?path=fixture`, {
        headers: dataHeaders(sandbox),
        signal,
      })
      const reader = response.body?.getReader()
      if (reader === undefined) throw new Error('download has no body')
      expect((await reader.read()).value).toEqual(new TextEncoder().encode('first'))
      await pulling
      const result = reader.read().catch((error: unknown) => error)
      const shutdown = app.close()
      try {
        await vi.waitFor(() => {
          expect(entry.acceptingJobs).toBe(false)
        })
        expect(stop).not.toHaveBeenCalled()
      } finally {
        release()
      }
      await shutdown
      expect(await result).toBeInstanceOf(Error)
      expect(sourceClosed).toBe(true)
      expect(stop).toHaveBeenCalledOnce()
    } finally {
      release()
    }
  })

  it('settles a running mutation before stopping the workspace', async () => {
    const { app } = await setup()
    const sandbox = await create(app)
    const id = sandbox.sandboxID
    const headers = dataHeaders(sandbox)
    delete headers['content-type']
    const entry = app.registry.get(id)
    const stop = vi.spyOn(entry.runner, 'stop')
    let admit = (): void => undefined
    const admitted = new Promise<void>((resolve) => {
      admit = resolve
    })
    let release = (): void => undefined
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const mkdir = vi.spyOn(SandboxFiles.prototype, 'mkdir').mockImplementation(async () => {
      admit()
      await pending
    })
    const mutate = async () =>
      app.inject({
        method: 'POST',
        url: '/filesystem.Filesystem/MakeDir',
        headers,
        payload: { path: 'fixture' },
      })
    const first = mutate()
    await admitted
    const killing = kill(app, id)
    try {
      await vi.waitFor(() => {
        expect(entry.acceptingJobs).toBe(false)
      })
      expect(stop).not.toHaveBeenCalled()
      expect((await mutate()).statusCode).toBe(401)
      expect(mkdir).toHaveBeenCalledTimes(1)
    } finally {
      release()
    }
    expect((await first).statusCode).toBe(200)
    expect((await killing).statusCode).toBe(204)
    expect(stop).toHaveBeenCalledOnce()
  })

  it('uses the addressed workspace for all six file routes', async () => {
    const { app } = await setup()
    const sandbox = await create(app)
    const headers = dataHeaders(sandbox)
    delete headers['content-type']
    function rpc(method: string, payload: Record<string, unknown>) {
      return app.inject({
        method: 'POST',
        url: `/filesystem.Filesystem/${method}`,
        headers,
        payload,
      })
    }

    const directory = { path: 'nested/dir' }
    expect((await rpc('MakeDir', directory)).statusCode).toBe(200)
    expect((await rpc('MakeDir', directory)).json()).toMatchObject({ code: 'already_exists' })

    const path = 'nested/dir/fixture.bin'
    const content = Buffer.from([0, 255, 130])
    const multipart = Buffer.concat([
      Buffer.from(
        '--stage-test\r\nContent-Disposition: form-data; name="file"; filename="fixture.bin"\r\n' +
          'Content-Type: application/octet-stream\r\n\r\n',
      ),
      content,
      Buffer.from('\r\n--stage-test--\r\n'),
    ])
    const url = `/files?path=${encodeURIComponent(path)}`
    const uploaded = await app.inject({
      method: 'POST',
      url,
      headers: { ...headers, 'content-type': 'multipart/form-data; boundary=stage-test' },
      payload: multipart,
    })
    expect(uploaded.statusCode, uploaded.body).toBe(200)
    expect(uploaded.json()).toMatchObject([{ path: `/home/user/${path}` }])
    expect((await app.inject({ method: 'GET', url, headers })).rawPayload).toEqual(content)
    expect((await rpc('Stat', { path })).json()).toMatchObject({
      entry: { size: String(content.length) },
    })
    expect(
      (await rpc('ListDir', { path: 'nested', depth: 2 }))
        .json<{ entries: { name: string }[] }>()
        .entries.map((entry) => entry.name),
    ).toContain('fixture.bin')

    const rejected = await app.inject({
      method: 'GET',
      url,
      headers: { ...headers, 'x-access-token': 'wrong' },
    })
    expect(rejected.statusCode).toBe(401)
    expect(rejected.json()).toMatchObject({ code: 401 })
    expect((await rpc('Remove', { path: 'nested' })).json()).toMatchObject({
      code: 'failed_precondition',
    })
    expect((await app.inject({ url, headers })).statusCode).toBe(200)
    expect((await rpc('Remove', { path })).statusCode).toBe(200)
    expect((await rpc('Stat', { path })).json()).toMatchObject({ code: 'not_found' })
  })

  it('lists to the requested depth without following symlinks', async () => {
    const { app } = await setup()
    const headers = dataHeaders(await create(app))
    const prepared = await runCommand(
      app,
      headers,
      processBody('mkdir -p tree/a/b; touch tree/a/b/leaf; ln -s /home/user/tree tree/a/b/loop'),
    )
    expect(prepared.at(-2)?.payload.event?.end?.exitCode).toBe(0)
    delete headers['content-type']
    const list = (depth?: unknown) =>
      app.inject({
        method: 'POST',
        url: '/filesystem.Filesystem/ListDir',
        headers,
        payload: { path: 'tree', depth },
      })
    const deepest = ['a', 'a/b', 'a/b/leaf', 'a/b/loop']
    for (const [depth, paths] of [
      [undefined, ['a']],
      [2, ['a', 'a/b']],
      [3, deepest],
      [0xffffffff, deepest],
    ] as const) {
      const response = await list(depth)
      expect(response.statusCode, response.body).toBe(200)
      const { entries } = response.json<{ entries: { name: string; path: string }[] }>()
      expect(entries.map((entry) => entry.path).sort()).toEqual(
        paths.map((path) => '/home/user/tree/' + path),
      )
      if (paths === deepest) {
        expect(entries.find((entry) => entry.name === 'loop')).toMatchObject({
          type: 'FILE_TYPE_SYMLINK',
          symlinkTarget: '/home/user/tree',
        })
      }
    }
    for (const invalid of [0, -1, 0x100000000, 1.5, true, '3']) {
      const response = await list(invalid)
      expect(response.statusCode).toBe(400)
      expect(response.json()).toMatchObject({ code: 'invalid_argument' })
    }
  })

  it('returns a multipart error before a malformed or oversized upload ends', async () => {
    const { app } = await setup()
    const sandbox = await create(app)
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const agent = new Agent({ keepAlive: true })
    const headers = { ...dataHeaders(sandbox), 'content-type': 'multipart/form-data; boundary=e2b' }
    const url = address + '/files?path=refused'
    const head = (name: string): string =>
      `--e2b\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n`
    try {
      const malformed = streamingPost(url, headers, agent)
      malformed.client.write(head('wrong'))
      const bad = await malformed.reply
      expect(bad.status).toBe(400)
      expect(bad.connection).toBe('close')

      const oversized = streamingPost(url, headers, agent)
      oversized.client.write(head('file'))
      const mib = Buffer.alloc(1024 * 1024)
      for (let i = 0; i < 64; i++) {
        if (!oversized.client.write(mib)) await once(oversized.client, 'drain')
      }
      const large = await oversized.reply
      expect(large.status).toBe(413)
      expect(large.connection).toBe('close')

      const valid = streamingPost(url, headers, agent)
      valid.client.end(head('file') + 'content\r\n--e2b--\r\n')
      const accepted = await valid.reply
      expect(accepted.status, accepted.body.toString()).toBe(200)
      expect(accepted.connection).toBe('keep-alive')
    } finally {
      agent.destroy()
    }
  })

  it('protects the mount a directory resolves to', async () => {
    const { app } = await setup()
    const headers = dataHeaders(await create(app))
    const prepared = await runCommand(
      app,
      headers,
      processBody('touch keep.txt; ln -s /home/user workspace-link'),
    )
    expect(prepared.at(-2)?.payload.event?.end?.exitCode).toBe(0)
    delete headers['content-type']

    const refused = await app.inject({
      method: 'POST',
      url: '/filesystem.Filesystem/Remove',
      headers,
      payload: { path: 'workspace-link/' },
    })
    expect(refused.statusCode).toBe(400)
    expect(refused.json()).toEqual({
      code: 'failed_precondition',
      message: 'cannot remove a mount',
    })
    const removed = await app.inject({
      method: 'POST',
      url: '/filesystem.Filesystem/Remove',
      headers,
      payload: { path: 'workspace-link' },
    })
    expect(removed.statusCode).toBe(200)
    const kept = await app.inject({
      method: 'POST',
      url: '/filesystem.Filesystem/Stat',
      headers,
      payload: { path: 'keep.txt' },
    })
    expect(kept.statusCode).toBe(200)
  })
})
