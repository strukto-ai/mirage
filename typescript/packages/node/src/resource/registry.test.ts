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

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { normalizeOneDriveConfig } from '@struktoai/mirage-core/accessor/onedrive'
import { tokenUrl } from '@struktoai/mirage-core/core/google/client'
import type { TokenManager } from '@struktoai/mirage-core/core/google/client'
import { normalizeMem0Config } from '@struktoai/mirage-core/resource/mem0/config'
import { Mem0Resource } from '@struktoai/mirage-core/resource/mem0/mem0'
import { OneDriveResource } from '@struktoai/mirage-core/resource/onedrive/onedrive'
import { resourceStateRequiresOverride } from '@struktoai/mirage-core/resource/secrets'
import { ResourceName } from '@struktoai/mirage-core/types'
import { normalizeS3Config } from './s3/config.ts'
import { buildResource, knownResources, register } from './registry.ts'

// Captured before any test calls register(), which is the public hook for
// custom resources and legitimately adds names with no ResourceName.
const BUILTIN_RESOURCES = knownResources()

// The committed dump scripts/check_spec_parity.py diffs against Python. This
// used to be nine hand-written `toContain` spot-checks, which could not
// notice that chroma/dify/lancedb/qdrant had no factory at all.
const SPEC_RESOURCES = resolve(
  fileURLToPath(import.meta.url),
  '../../../../../../spec/typescript/node/resources.json',
)

describe('node resource registry', () => {
  it('matches the committed spec manifest, sorted', () => {
    const manifest = JSON.parse(readFileSync(SPEC_RESOURCES, 'utf8')) as { registry: string[] }
    expect(BUILTIN_RESOURCES).toEqual([...manifest.registry].sort())
    expect(BUILTIN_RESOURCES).toEqual([...BUILTIN_RESOURCES].sort())
  })

  // The four Drive-family resources used to redeclare core's GoogleConfig
  // without apiBase and hand-pick TokenManager fields, so a mount pointed
  // at a fake server still refreshed its token at Google's real endpoint.
  it('threads api_base into every google resource token manager', async () => {
    const base = 'http://127.0.0.1:9999'
    for (const name of ['gdrive', 'gdocs', 'gsheets', 'gslides', 'gmail']) {
      const resource = await buildResource(name, {
        client_id: 'id',
        client_secret: 'secret',
        refresh_token: 'refresh',
        api_base: base,
      })
      const { accessor } = resource as unknown as { accessor: { tokenManager: TokenManager } }
      expect(tokenUrl(accessor.tokenManager.config), name).toBe(`${base}/token`)
    }
  })

  it('builds Microsoft Graph and Mem0 resources from snake_case config', async () => {
    const oneDrive = await buildResource('onedrive', {
      access_token: 'token',
      drive_id: 'drive',
    })
    const sharePoint = await buildResource('sharepoint', { access_token: 'token' })
    const mem0 = await buildResource('mem0', { api_key: 'key', user_id: 'user' })

    expect(oneDrive.kind).toBe('onedrive')
    expect(sharePoint.kind).toBe('sharepoint')
    expect(mem0.kind).toBe('mem0')
  })

  // The factories used to double-cast an unvalidated blob, so a bad config
  // only failed later at the first API call.
  it('validates Microsoft Graph and Mem0 config instead of casting it through', async () => {
    await expect(buildResource('onedrive', { drive_id: 'drive' })).rejects.toThrow()
    await expect(buildResource('sharepoint', { access_token: 7 })).rejects.toThrow()
    await expect(buildResource('mem0', { api_key: 'key', user_id: 3 })).rejects.toThrow()
  })

  // Every normalizer is `parseConfigWithSchema` now, so a wrong-typed mount
  // config is refused at the door the way pydantic refuses it on the python
  // side, and the refusal names the field and the code the way
  // `build_resource` does -- never the value it refused.
  it('refuses a wrong-typed config for every backend, naming field and code', async () => {
    await expect(buildResource('s3', { bucket: 123 })).rejects.toThrow(/^s3: bucket: invalid_type$/)
    await expect(buildResource('ssh', { host: 'h', port: '22' })).rejects.toThrow(
      /^ssh: port: invalid_type$/,
    )
    await expect(buildResource('github', { token: [], owner: 'o', repo: 'r' })).rejects.toThrow(
      /^github: token: invalid_type$/,
    )
    await expect(buildResource('postgres', { dsn: 'd', max_read_rows: 'many' })).rejects.toThrow(
      /^postgres: maxReadRows: invalid_type$/,
    )
    // A Google mount naming no credential is refused here, not on its first
    // read; the model-level check reports as `config`, as python's does.
    await expect(buildResource('gdrive', { api_base: 'http://127.0.0.1:1' })).rejects.toThrow(
      /^gdrive: config: custom$/,
    )
  })

  it('serves a pre-minted Google access token without the refresh grant', async () => {
    const resource = await buildResource('gdrive', { access_token: 'sa-token' })
    const { accessor } = resource as unknown as { accessor: { tokenManager: TokenManager } }
    expect(await accessor.tokenManager.getToken()).toBe('sa-token')
  })

  // The python wire spelling of every field reaches the resource and the
  // credentials among them redact out of snapshot state.
  it('keeps every declared field through the door and redacts the secrets', async () => {
    const ssh = await buildResource('ssh', {
      host: 'h',
      username: 'u',
      password: 'pw',
      identity_file: '~/k',
      passphrase: 'pp',
    })
    expect(await ssh.getState()).toMatchObject({
      type: 'ssh',
      config: {
        host: 'h',
        username: 'u',
        password: '<REDACTED>',
        identityFile: '~/k',
        passphrase: '<REDACTED>',
      },
    })
    const notion = await buildResource('notion', { api_key: 'k', api_version: '2025-09-03' })
    expect((await notion.getState()).config).toMatchObject({ apiVersion: '2025-09-03' })
    const oci = await buildResource('oci', {
      bucket: 'b',
      namespace: 'ns',
      region: 'us-ashburn-1',
      path_style: false,
    })
    const { aliasConfig } = oci as unknown as { aliasConfig: { forcePathStyle?: boolean } }
    expect(aliasConfig.forcePathStyle).toBe(false)
  })

  // getState() used to hand-write the redacted literal, so a field added to
  // the config later would silently leak or vanish from snapshot state. It is
  // schema-driven now, so the config shape is the single source of truth.
  it('redacts Graph and Mem0 secrets in state and keeps every other field', () => {
    const oneDrive = new OneDriveResource(
      normalizeOneDriveConfig({ access_token: 'token', drive_id: 'drive', key_prefix: 'sub' }),
    )
    const mem0 = new Mem0Resource(
      normalizeMem0Config({ api_key: 'key', user_id: 'user', default_page_size: 5 }),
    )

    expect(oneDrive.getState()).toEqual({
      type: 'onedrive',
      config: { accessToken: '<REDACTED>', driveId: 'drive', keyPrefix: 'sub' },
    })
    expect(mem0.getState()).toEqual({
      type: 'mem0',
      config: { apiKey: '<REDACTED>', userId: 'user', defaultPageSize: 5 },
    })
    expect(resourceStateRequiresOverride(oneDrive.getState())).toBe(true)
    expect(resourceStateRequiresOverride(mem0.getState())).toBe(true)
  })

  it('builds MongoDB with uri', async () => {
    const r = await buildResource('mongodb', { uri: 'mongodb://localhost' })
    expect(r.kind).toBe('mongodb')
  })

  it('builds Postgres with dsn', async () => {
    const r = await buildResource('postgres', {
      dsn: 'postgres://localhost/db',
    })
    expect(r.kind).toBe('postgres')
  })

  it('Postgres: accepts snake_case max_read_rows → maxReadRows', async () => {
    const r = (await buildResource('postgres', {
      dsn: 'postgres://localhost/db',
      max_read_rows: 50,
    })) as unknown as { config: { maxReadRows: number } }
    expect(r.config.maxReadRows).toBe(50)
  })

  it('builds Notion with api key', async () => {
    const r = await buildResource('notion', { api_key: 'secret' })
    expect(r.kind).toBe('notion')
  })

  it('builds RAM with no config', async () => {
    const r = await buildResource('ram', {})
    expect(r.kind).toBe('ram')
  })

  it('builds Disk with root', async () => {
    const r = await buildResource('disk', { root: '/tmp' })
    expect(r.kind).toBe('disk')
  })

  it('builds S3 with bucket', async () => {
    const r = await buildResource('s3', {
      bucket: 'test-bucket',
      region: 'us-east-1',
    })
    expect(r.kind).toBe('s3')
  })

  it('throws on unknown name with helpful message', async () => {
    await expect(buildResource('nope', {})).rejects.toThrow(/unknown resource/)
    await expect(buildResource('nope', {})).rejects.toThrow(/known: /)
  })

  it('supports registering a custom factory', async () => {
    register('mock-fs', async () => {
      const { RAMResource } = await import('@struktoai/mirage-core/resource/ram/ram')
      return new RAMResource()
    })
    expect(knownResources()).toContain('mock-fs')
    const r = await buildResource('mock-fs', {})
    expect(r.kind).toBe('ram')
  })

  it('S3: accepts Python YAML snake_case keys', async () => {
    const { config } = (await buildResource('s3', {
      bucket: 'b',
      region: 'us-east-1',
      aws_access_key_id: 'AKIA',
      aws_secret_access_key: 'SECRET',
      aws_session_token: 'SESS',
      aws_profile: 'prod',
      endpoint_url: 'https://example.com',
      path_style: true,
      timeout: 30,
      proxy: 'http://proxy.example',
    })) as unknown as { config: Record<string, unknown> }
    expect(config).toMatchObject({
      bucket: 'b',
      region: 'us-east-1',
      accessKeyId: 'AKIA',
      secretAccessKey: 'SECRET',
      sessionToken: 'SESS',
      profile: 'prod',
      endpoint: 'https://example.com',
      forcePathStyle: true,
      timeoutMs: 30_000,
      proxy: 'http://proxy.example',
    })
  })

  it('S3: accepts already-camelCase keys (TS-idiomatic)', async () => {
    const { config } = (await buildResource('s3', {
      bucket: 'b',
      accessKeyId: 'AKIA',
      secretAccessKey: 'SECRET',
      forcePathStyle: false,
    })) as unknown as { config: Record<string, unknown> }
    expect(config).toMatchObject({
      bucket: 'b',
      accessKeyId: 'AKIA',
      secretAccessKey: 'SECRET',
      forcePathStyle: false,
    })
  })

  it('Redis: snake_case key_prefix → keyPrefix', async () => {
    const r = (await buildResource('redis', {
      url: 'redis://localhost:6379/0',
      key_prefix: 'mirage:test:',
    })) as { kind: string }
    expect(r.kind).toBe('redis')
  })

  it('Nextcloud: accepts Python YAML snake_case keys', async () => {
    const resource = await buildResource('nextcloud', {
      url: 'https://cloud.example/remote.php/dav/files/alice/',
      username: 'alice',
      password: 'secret',
      verify_ssl: false,
    })
    expect(resource.kind).toBe('nextcloud')
    const { config } = resource as unknown as {
      config: { username?: string; verifySsl?: boolean }
    }
    expect(config).toMatchObject({ username: 'alice', verifySsl: false })
  })

  it('normalizeS3Config standalone', () => {
    expect(
      normalizeS3Config({
        bucket: 'b',
        aws_access_key_id: 'A',
        endpoint_url: 'https://x',
        timeout: 5,
        proxy: 'p',
      }),
    ).toEqual({
      bucket: 'b',
      accessKeyId: 'A',
      endpoint: 'https://x',
      timeoutMs: 5_000,
      proxy: 'p',
    })
  })
})

describe('hf resources in registry', () => {
  it('lists all four hf resources', () => {
    const names = knownResources()
    for (const n of ['hf_buckets', 'hf_datasets', 'hf_models', 'hf_spaces']) {
      expect(names).toContain(n)
    }
  })

  it('builds hf_models from Python YAML snake_case keys', async () => {
    const r = await buildResource('hf_models', {
      repo_id: 'ns/model',
      token: 't',
      key_prefix: 'sub',
      timeout: 30,
      revision: 'main',
    })
    expect(r.kind).toBe('hf_models')
    const { config } = r as unknown as {
      config: { repoId: string; keyPrefix?: string; timeoutMs?: number; revision?: string }
    }
    expect(config.repoId).toBe('ns/model')
    expect(config.keyPrefix).toBe('sub/')
    expect(config.timeoutMs).toBe(30000)
    expect(config.revision).toBe('main')
  })

  it('builds hf_buckets, hf_datasets, and hf_spaces', async () => {
    expect((await buildResource('hf_buckets', { bucket: 'ns/b' })).kind).toBe('hf_buckets')
    expect((await buildResource('hf_datasets', { repo_id: 'ns/d' })).kind).toBe('hf_datasets')
    expect((await buildResource('hf_spaces', { repo_id: 'ns/s' })).kind).toBe('hf_spaces')
  })

  it('rejects an hf repo id the Hub cannot read, but not a bare one', async () => {
    await expect(buildResource('hf_models', { repo_id: 'a/b/c' })).rejects.toThrow(
      /namespace\/name/,
    )
    // A bare name resolves against the token's owner; refusing it rejected an
    // id the Hub had just minted.
    await expect(buildResource('hf_models', { repo_id: 'plain' })).resolves.toBeDefined()
  })
})

describe('ResourceName coverage', () => {
  // Names that are deliberately not buildable from the node registry.
  const BROWSER_ONLY = new Set(['opfs'])
  // `history` is an internal view mount, never named in user config.
  const INTERNAL = new Set(['history'])
  // Config-mountable in python but not yet wired into a TypeScript registry.
  // Listing them keeps the gap visible instead of hiding it behind a count.
  const PYTHON_ONLY = new Set(['chroma', 'dify', 'lancedb', 'qdrant'])

  it('every resource name is buildable or explicitly exempt', () => {
    // This is the guard a hardcoded entry count cannot give: adding a backend
    // to ResourceName without a registry factory fails here, naming it.
    const known = new Set(BUILTIN_RESOURCES)
    const unreachable = Object.values(ResourceName).filter(
      (name) =>
        !known.has(name) &&
        !BROWSER_ONLY.has(name) &&
        !INTERNAL.has(name) &&
        !PYTHON_ONLY.has(name),
    )
    expect(unreachable).toEqual([])
  })

  it('every built-in registry factory has a ResourceName', () => {
    const names = new Set<string>(Object.values(ResourceName))
    expect(BUILTIN_RESOURCES.filter((n) => !names.has(n))).toEqual([])
  })
})

// A colon reference names a class rather than a registry key, so it is
// exercised through a real file on disk: that is the path a deployment
// takes, and it is the only way the loader's own module resolution is
// covered. The fixture is `.mjs` because Node strips types without
// compiling them, so a `.ts` fixture using a parameter property would be
// refused at load.
describe('buildResource colon reference', () => {
  const CORE = pathToFileURL(
    resolve(fileURLToPath(import.meta.url), '../../../../core/dist/index.js'),
  ).href
  const BACKEND =
    `import {RAMResource} from ${JSON.stringify(CORE)}\n` +
    'export class WikiResource extends RAMResource {\n' +
    '  constructor(config) { super(); this.config = config }\n' +
    '}\n' +
    'export class LateResource extends RAMResource {\n' +
    '  static async create(config) { const r = new LateResource(); r.config = config; return r }\n' +
    '}\n' +
    'export class NotAResource {}\n' +
    'export class HalfResource {\n' +
    '  get kind() { return "half" }\n' +
    '  async open() {}\n' +
    '  async close() {}\n' +
    '}\n' +
    'export class NamelessResource {\n' +
    '  kind = ""\n' +
    '  async open() {}\n' +
    '  async close() {}\n' +
    '  getState() { return {type: ""} }\n' +
    '  loadState() {}\n' +
    '}\n' +
    'export const NOT_A_CLASS = {name: "wiki"}\n'

  function fixture(): string {
    const dir = mkdtempSync(join(tmpdir(), 'mirage-resref-'))
    writeFileSync(join(dir, 'wiki.mjs'), BACKEND)
    return dir
  }

  it('builds from the class the ref names', async () => {
    const dir = fixture()
    const built = await buildResource(`${join(dir, 'wiki.mjs')}:WikiResource`, { root: '/ref' })
    expect(built.constructor.name).toBe('WikiResource')
    expect((built as unknown as { config: unknown }).config).toEqual({ root: '/ref' })
    await built.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('prefers a static create over the constructor', async () => {
    const dir = fixture()
    const built = await buildResource(`${join(dir, 'wiki.mjs')}:LateResource`, { root: '/late' })
    expect(built.constructor.name).toBe('LateResource')
    expect((built as unknown as { config: unknown }).config).toEqual({ root: '/late' })
    await built.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('never lets a ref shadow a registry name', async () => {
    // A registry name always wins, so a name cannot be reread as code.
    const built = await buildResource('ram')
    expect(built.constructor.name).toBe('RAMResource')
    await built.close()
  })

  it('refuses a ref that names something other than a class', async () => {
    const dir = fixture()
    await expect(buildResource(`${join(dir, 'wiki.mjs')}:NOT_A_CLASS`)).rejects.toThrow(
      'must name a class',
    )
    rmSync(dir, { recursive: true, force: true })
  })

  it('refuses a class that does not build a resource', async () => {
    const dir = fixture()
    await expect(buildResource(`${join(dir, 'wiki.mjs')}:NotAResource`)).rejects.toThrow(
      'is missing open, close, getState, loadState',
    )
    rmSync(dir, { recursive: true, force: true })
  })

  it('names the members a half-built resource left out', async () => {
    // open/close alone used to pass, and the class reached installMounts and
    // then crashed Workspace.save() on the getState it never declared.
    const dir = fixture()
    await expect(buildResource(`${join(dir, 'wiki.mjs')}:HalfResource`)).rejects.toThrow(
      'is missing getState, loadState',
    )
    rmSync(dir, { recursive: true, force: true })
  })

  it('refuses a resource whose kind is empty', async () => {
    // kind is how a command or op registered for this backend is found, so
    // an empty one registers nothing and fails nowhere.
    const dir = fixture()
    await expect(buildResource(`${join(dir, 'wiki.mjs')}:NamelessResource`)).rejects.toThrow(
      'has no kind',
    )
    rmSync(dir, { recursive: true, force: true })
  })

  it('still reports an unknown bare name as unknown', async () => {
    await expect(buildResource('nope')).rejects.toThrow('unknown resource')
  })
})
