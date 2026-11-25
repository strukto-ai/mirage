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
import { CONFIGS_PREFIX, OWNERS_PREFIX } from '../registry.ts'

const API_KEY = { 'x-api-key': 'test-key' }
const BEARER = { authorization: 'Bearer test-key' }
const RAM = { mounts: { '/home/user': { vfs: 'ram', mode: 'write' } } }
const CREATE = '/v2/sandboxes'

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
