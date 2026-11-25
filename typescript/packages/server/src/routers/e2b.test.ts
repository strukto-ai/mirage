import { Buffer } from 'node:buffer'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { memoryResourceStore } from '@struktoai/mirage-core/resources/memory'
import { RAMWorkspaceStateStore } from '@struktoai/mirage-core/workspace/store/ram'
import { DiskRecordClient, DiskWorkspaceStateStore } from '@struktoai/mirage-node'
import { SignJWT } from 'jose'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildApp, type BuildAppOptions, type MirageApp } from '../app.ts'
import { AuthMode, type AuthConfig } from '../auth/config.ts'
import { CONNECT_STREAM } from '../e2b/process.ts'
import { CONFIGS_PREFIX, OWNERS_PREFIX } from '../registry.ts'

const API_KEY = { 'x-api-key': 'test-key' }
const BEARER = { authorization: 'Bearer test-key' }
const RAM = { mounts: { '/home/user': { vfs: 'ram', mode: 'write' } } }
const CREATE = '/v2/sandboxes'
const START = '/process.Process/Start'

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
  vi.useRealTimers()
  for (const app of applications.splice(0)) await app.close()
  for (const path of stateRoots.splice(0)) await rm(path, { recursive: true, force: true })
})

async function setup(options: BuildAppOptions = {}) {
  const stateRoot = options.stateRoot ?? (await mkdtemp(join(tmpdir(), 'mirage-e2b-')))
  if (options.stateRoot === undefined) stateRoots.push(stateRoot)
  const templateRoot = join(stateRoot, 'template-state')
  const resourceStore = memoryResourceStore()
  await resourceStore.createTemplate({
    name: 'approved',
    description: null,
    config: { ...RAM, store: { type: 'disk', root: templateRoot } },
  })
  const app = buildApp({
    authConfig: { mode: AuthMode.Token, bearerToken: API_KEY['x-api-key'] },
    e2bTemplate: 'approved',
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
  it('requires opt-in and an actual API key, scoped to the lifecycle routes', async () => {
    const { app: disabled } = await setup({ e2bTemplate: '' })
    expect(
      (await disabled.inject({ method: 'POST', url: CREATE, headers: BEARER })).statusCode,
    ).toBe(404)

    const { app: noCredential } = await setup({ authConfig: { mode: AuthMode.Local } })
    const local = await noCredential.inject({ method: 'POST', url: CREATE, headers: API_KEY })
    expect(local.statusCode).toBe(401)
    expect(local.json()).toEqual({ code: 401, message: 'unauthorized' })

    const { app } = await setup()
    for (const headers of [{}, BEARER, { 'x-api-key': 'incorrect' }]) {
      const refused = await app.inject({ method: 'POST', url: CREATE, headers })
      expect(refused.statusCode).toBe(401)
      expect(refused.json()).toEqual({ code: 401, message: 'unauthorized' })
    }
    expect((await app.inject({ url: CREATE, headers: API_KEY })).statusCode).toBe(401)
    expect((await app.inject({ url: '/v1/workspaces', headers: API_KEY })).statusCode).toBe(401)
    expect((await app.inject({ url: '/v1/workspaces', headers: BEARER })).statusCode).toBe(200)
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

  it('revokes a lease when its workspace is stopped through the native API', async () => {
    const { app } = await setup()
    const { sandboxID: id } = await create(app)
    const stopped = await app.inject({
      method: 'POST',
      url: `/v1/workspaces/${id}/stop`,
      headers: BEARER,
    })
    expect(stopped.statusCode).toBe(200)
    expect((await connect(app, id, 300)).statusCode).toBe(404)
    expect((await kill(app, id)).statusCode).toBe(404)
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
      payload: { event: { end: { exitCode: 7, exited: true, status: 'exit status 7' } } },
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
