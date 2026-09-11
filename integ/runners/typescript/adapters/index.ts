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

import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { gzipSync } from 'node:zlib'
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3'
import { OPFSResource, Workspace as BrowserWorkspace } from '@struktoai/mirage-browser'
import type { ConsistencyPolicy } from '@struktoai/mirage-node'
import {
  AliyunResource,
  BackblazeResource,
  BoxResource,
  CephResource,
  ChromaResource,
  DatabricksVolumeResource,
  DifyResource,
  DigitalOceanResource,
  DiscordResource,
  DiskResource,
  DropboxResource,
  EmailResource,
  GDocsResource,
  GDriveResource,
  GmailResource,
  GCalResource,
  GCSResource,
  GitHubResource,
  GridFSResource,
  GSheetsResource,
  GSlidesResource,
  DISCORD,
  GWS,
  HIMALAYA,
  GH,
  HF,
  GIT,
  LINEAR,
  NTN,
  SLACK,
  HfBucketsResource,
  HfDatasetsResource,
  HfModelsResource,
  HfSpacesResource,
  JaegerResource,
  JobConsole,
  LanceDBResource,
  LangfuseResource,
  LinearResource,
  MinIOResource,
  Mem0Resource,
  MongoDBResource,
  NotionResource,
  MountMode,
  NextcloudResource,
  OCIResource,
  OneDriveResource,
  PostgresResource,
  QdrantResource,
  QingStorResource,
  R2Resource,
  RAMResource,
  RedisConsoleStore,
  RedisResource,
  type Resource,
  S3Resource,
  ScalewayResource,
  SeaweedFSResource,
  SharePointResource,
  SlackResource,
  SSHResource,
  SupabaseResource,
  TencentResource,
  TrelloResource,
  WasabiResource,
  Workspace,
  type ConsoleFactory,
} from '@struktoai/mirage-node'
import { parseSessionProfile, type SessionProfile } from '@struktoai/mirage-core/policy/profile'
import { ScriptSource } from '@struktoai/mirage-core/runtime/routing/types'
import * as lancedb from '@lancedb/lancedb'
import { QdrantClient } from '@qdrant/js-client-rest'
import { ChromaClient } from 'chromadb'
import { Double, MongoClient } from 'mongodb'
import pg from 'pg'
import {
  installFakeNavigator,
  makeMockRoot,
} from '../../../../typescript/packages/browser/src/test-utils.ts'
import { integRoot, walkFiles } from '../harness.ts'
import type { ExecWorkspace, Mount, Target } from '../harness.ts'
import { buildSecretsEnv } from './secrets.ts'
import { start as startKitFake } from '../../../server/kit/typescript/index.ts'
import { buildRfc822 } from '../../../server/mail/rfc822.ts'
import type { MailEntry } from '../../../server/mail/rfc822.ts'

export interface Open {
  ws: ExecWorkspace
  cleanup: () => Promise<void>
  // A second workspace over the same backing store, which consistency
  // scenarios mutate through. Adapters that can build their mounts more than
  // once expose it; the rest leave it undefined and the runner reports their
  // consistency cases as skipped instead of silently dropping them.
  shadow?: () => ExecWorkspace
}

export interface OpenConsistency extends Open {
  mutate: (path: string, content: Uint8Array) => Promise<void>
}

export interface OpenOptions {
  consistency?: ConsistencyPolicy
}

type MountMap = ConstructorParameters<typeof Workspace>[0]

interface OpenedWorkspaces {
  ws: ExecWorkspace
  shadow: () => ExecWorkspace
  closeAll: () => Promise<void>
}

/**
 * The workspace an adapter hands back, plus the shadow factory.
 *
 * `build` must return fresh resources on every call: two workspaces sharing
 * resource instances share their caches, and a consistency scenario mutating
 * through one would invalidate the other's — which is exactly the thing the
 * scenario is there to observe.
 */
function openWorkspaces(build: () => MountMap, options?: OpenOptions): OpenedWorkspaces {
  const opened: Workspace[] = []
  const make = (consistency?: ConsistencyPolicy): ExecWorkspace => {
    const ws = new Workspace(build(), {
      mode: MountMode.WRITE,
      ...(consistency !== undefined ? { consistency } : {}),
    })
    opened.push(ws)
    return ws as unknown as ExecWorkspace
  }
  return {
    ws: make(options?.consistency),
    shadow: () => make(),
    closeAll: async (): Promise<void> => {
      for (const ws of opened) await ws.close()
    },
  }
}

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379/0'
const MONGODB_URI = process.env.MONGODB_URI ?? 'mongodb://localhost:27017'
const S3_ENDPOINT = process.env.S3_ENDPOINT
const S3_REGION = process.env.S3_REGION ?? 'us-east-1'
const S3_ACCESS = process.env.AWS_ACCESS_KEY_ID ?? 'testing'
const S3_SECRET = process.env.AWS_SECRET_ACCESS_KEY ?? 'testing'
const NEXTCLOUD_URL = process.env.NEXTCLOUD_URL
const NEXTCLOUD_USERNAME = process.env.NEXTCLOUD_USERNAME ?? 'admin'
const NEXTCLOUD_PASSWORD = process.env.NEXTCLOUD_PASSWORD ?? 'admin123'
function runId(): string {
  return `${String(process.pid)}-${String(Date.now())}`
}

/**
 * Install the CLIs a mount-backed target declares.
 *
 * `git` is the first CLI here that talks to no API: it reads a repository out of
 * a mount, which is what makes it installable from a bare name with no config at
 * all, where every other one needs its mock service to hand over both the tree
 * and the credentials pointing at itself.
 */
function installLocalClis(
  ws: { registerCli: (name: string, spec: unknown) => void },
  target: Target,
): void {
  if (target.clis?.includes('git') === true) ws.registerCli('git', GIT)
}

// Where a target declares console: {type: 'redis'}, each job's console
// rides its own Redis stream on REDIS_URL. The nonce beside the id
// matters because battery cases reap jobs and ids restart at 1; a
// reused stream would replay the previous case's chunks, ending chunk
// included. Only the ram opener consults this (main.ts refuses a
// console block on any other resource), and ws.close() releases the
// clients through JobTable.closeConsoles.
function consoleFactoryFor(target: Target): ConsoleFactory | undefined {
  if (target.console?.type !== 'redis') return undefined
  const url = process.env.REDIS_URL ?? 'redis://localhost:6379/0'
  const prefix = `mirage-integ-console-${randomBytes(4).toString('hex')}:`
  return (jobId: number) =>
    new JobConsole(
      new RedisConsoleStore({
        url,
        keyPrefix: `${prefix}${randomBytes(4).toString('hex')}-${jobId.toString()}:`,
        // Battery keys must not accumulate in the shared redis db.
        ttlSeconds: 3600,
      }),
    )
}

// The target's profiles, and which one shapes a session that names none.
// A profile is the whole permission document, so this is every permission
// the target states, including the per-mount ones; the parser is the
// one the YAML door uses, so a case runs under exactly what a
// deployment would write. Only the openers that consult it may declare
// one (main.ts refuses it on any other resource), the same way the
// console block rides ram alone: an unwired opener would run the target
// unbound and it would read as covered.
/**
 * Wrap a profile's inline policy source the way the config door does.
 *
 * A target is JSON, so it carries a profile's policy as source rather than
 * as the path a YAML config would name. Loading is the config layer's
 * job everywhere else, so the battery does that one step here and hands
 * the workspace what code would pass.
 */
function scriptedProfile(doc: unknown): unknown {
  if (typeof doc !== 'object' || doc === null) return doc
  const policy = (doc as { policy?: unknown }).policy
  if (typeof policy !== 'object' || policy === null) return doc
  const { script, runtime } = policy as { script?: unknown; runtime?: unknown }
  if (typeof script !== 'object' || script === null) return doc
  const { source, language } = script as { source: string; language?: 'python' | 'js' }
  return {
    ...(doc as object),
    policy: { script: new ScriptSource(source, language ?? 'python'), runtime },
  }
}

function permissionOptions(target: Target): {
  profiles?: Record<string, SessionProfile>
  profile?: string
} {
  const profiles: Record<string, SessionProfile> = {}
  for (const [name, doc] of Object.entries(target.profiles ?? {})) {
    profiles[name] = parseSessionProfile(scriptedProfile(doc), `profile \`${name}\``)
  }
  return {
    ...(Object.keys(profiles).length > 0 ? { profiles } : {}),
    ...(target.profile !== undefined ? { profile: target.profile } : {}),
  }
}

async function openRam(target: Target): Promise<Open> {
  const mounts: Record<string, RAMResource | [RAMResource, MountMode]> = {}
  const built: Record<string, RAMResource> = {}
  for (const m of target.mounts) {
    // alias_of gives two prefixes one store: the shape that made
    // cross-mount mv copy an object onto itself and then unlink the
    // source. Every other path here allocates fresh storage.
    const existing = m.alias_of !== undefined ? built[m.alias_of] : undefined
    if (m.alias_of !== undefined && existing === undefined) {
      throw new Error(`alias_of names no built mount: ${m.alias_of}`)
    }
    const resource = existing ?? new RAMResource()
    built[m.path] = resource
    mounts[m.path] =
      m.mode === 'read'
        ? [resource, MountMode.READ]
        : m.mode === 'exec'
          ? [resource, MountMode.EXEC]
          : resource
  }
  const secretsEnv = target.secrets !== undefined ? buildSecretsEnv(target.secrets) : null
  const consoleFactory = consoleFactoryFor(target)
  const ws = new Workspace(mounts, {
    mode: MountMode.WRITE,
    ...(target.agentId !== undefined ? { agentId: target.agentId } : {}),
    ...(consoleFactory !== undefined ? { consoleFactory } : {}),
    ...(secretsEnv !== null ? { env: secretsEnv.env } : {}),
    ...permissionOptions(target),
  })
  installLocalClis(ws, target)
  const cleanup = async (): Promise<void> => {
    await ws.close()
    await secretsEnv?.cleanup()
  }
  return { ws: ws as unknown as ExecWorkspace, cleanup }
}

async function openDisk(target: Target): Promise<Open> {
  const roots: string[] = []
  const mounts: Record<string, DiskResource | [DiskResource, MountMode]> = {}
  for (const m of target.mounts) {
    const root = mkdtempSync(join(tmpdir(), 'mirage-integ-disk-'))
    roots.push(root)
    const resource = new DiskResource({ root })
    mounts[m.path] = m.mode === 'read' ? [resource, MountMode.READ] : resource
  }
  const ws = new Workspace(mounts, { mode: MountMode.WRITE, ...permissionOptions(target) })
  installLocalClis(ws, target)
  const cleanup = async (): Promise<void> => {
    await ws.close()
    for (const root of roots) rmSync(root, { recursive: true, force: true })
  }
  return { ws: ws as unknown as ExecWorkspace, cleanup }
}

async function openRedis(target: Target): Promise<Open> {
  const id = runId()
  const mounts: Record<string, RedisResource> = {}
  for (const m of target.mounts) {
    const safe = m.path.replace(/\/+/g, '-').replace(/^-|-$/g, '') || 'root'
    mounts[m.path] = new RedisResource({ url: REDIS_URL, keyPrefix: `mirage-integ-${id}-${safe}` })
  }
  const ws = new Workspace(mounts, { mode: MountMode.WRITE })
  return { ws: ws as unknown as ExecWorkspace, cleanup: () => ws.close() }
}

async function openOpfs(target: Target): Promise<Open> {
  const restoreNav = installFakeNavigator(() => makeMockRoot())
  const mounts: Record<string, OPFSResource> = {}
  target.mounts.forEach((m, i) => {
    mounts[m.path] = i === 0 ? new OPFSResource() : new OPFSResource({ root: `xm${String(i)}` })
  })
  const ws = new BrowserWorkspace(mounts, { mode: MountMode.WRITE })
  const cleanup = async (): Promise<void> => {
    await ws.close()
    restoreNav()
  }
  return { ws: ws as unknown as ExecWorkspace, cleanup }
}

async function openGridfs(target: Target, options?: OpenOptions): Promise<Open> {
  const id = runId()
  const uri = MONGODB_URI
  const database = `mirage_integ_${id}`
  const build = (): MountMap => {
    const mounts: Record<string, GridFSResource> = {}
    for (const m of target.mounts) {
      mounts[m.path] = new GridFSResource({
        uri,
        database,
        bucket: String(m.bucket),
        keyPrefix: m.prefix,
      })
    }
    return mounts
  }
  const opened = openWorkspaces(build, options)
  const cleanup = async (): Promise<void> => {
    await opened.closeAll()
    const { MongoClient } = await import('mongodb')
    const client = new MongoClient(uri)
    try {
      await client.db(database).dropDatabase()
    } finally {
      await client.close()
    }
  }
  return { ws: opened.ws, shadow: opened.shadow, cleanup }
}

// No subprocess and no CI setup: the fake is a kit fake now and this host is
// already a node process, so it starts in-process on an ephemeral port. The
// token is per-run because the fake reads it as its tenant.
async function openDatabricksVolume(target: Target): Promise<Open> {
  // Imported here rather than at the top of the file, because this module is
  // loaded for every target and a kit fake's module reaches its generated
  // Prisma client at import time. See the eslint rule in integ/eslint.config.js.
  const { databricksFake } = await import('../../../server/databricks/fake.ts')
  const server = await startKitFake(databricksFake)
  const endpoint = server.endpoint
  const id = runId()
  const token = `integ-${id}`
  const mounts: Record<string, DatabricksVolumeResource> = {}
  for (const m of target.mounts) {
    const volume = `mirage-integ-${id}-${String(m.volume)}`
    const rootPath = m.prefix ?? '/'
    const root = `/Volumes/main/default/${volume}${rootPath === '/' ? '' : `/${rootPath}`}`
    const created = await fetch(`${endpoint}/api/2.0/fs/directories${root}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!created.ok) throw new Error(`databricks mkdir root failed: ${String(created.status)}`)
    mounts[m.path] = await DatabricksVolumeResource.create({
      catalog: 'main',
      schema: 'default',
      volume,
      rootPath,
      host: endpoint,
      token,
      timeout: 30,
    })
  }
  const ws = new Workspace(mounts, { mode: MountMode.WRITE })
  const cleanup = async (): Promise<void> => {
    await ws.close()
    await server.close()
  }
  return { ws: ws as unknown as ExecWorkspace, cleanup }
}

function objectStorageResource(
  name: string,
  bucket: string,
  keyPrefix: string | undefined,
): S3Resource {
  if (S3_ENDPOINT === undefined) throw new Error('s3 target requires S3_ENDPOINT')
  const common = {
    bucket,
    region: S3_REGION,
    endpoint: S3_ENDPOINT,
    accessKeyId: S3_ACCESS,
    secretAccessKey: S3_SECRET,
    ...(keyPrefix !== undefined ? { keyPrefix } : {}),
  }
  if (name === 's3') return new S3Resource({ ...common, forcePathStyle: true })
  if (name === 'aliyun') return new AliyunResource({ ...common, forcePathStyle: true })
  if (name === 'backblaze') return new BackblazeResource({ ...common, forcePathStyle: true })
  if (name === 'ceph') return new CephResource(common)
  if (name === 'digitalocean') {
    return new DigitalOceanResource({ ...common, forcePathStyle: true })
  }
  if (name === 'gcs') return new GCSResource({ ...common, forcePathStyle: true })
  if (name === 'minio') return new MinIOResource(common)
  if (name === 'oci') return new OCIResource({ ...common, namespace: 'integ' })
  if (name === 'qingstor') return new QingStorResource({ ...common, forcePathStyle: true })
  if (name === 'r2') return new R2Resource({ ...common, forcePathStyle: true })
  if (name === 'scaleway') return new ScalewayResource({ ...common, forcePathStyle: true })
  if (name === 'seaweedfs') return new SeaweedFSResource(common)
  if (name === 'supabase') return new SupabaseResource(common)
  if (name === 'tencent') return new TencentResource({ ...common, forcePathStyle: true })
  if (name === 'wasabi') return new WasabiResource({ ...common, forcePathStyle: true })
  throw new Error(`unknown object storage resource: ${name}`)
}

async function openS3(target: Target, options?: OpenOptions): Promise<Open> {
  if (!S3_ENDPOINT) throw new Error('s3 target requires S3_ENDPOINT')
  const id = runId()
  const client = new S3Client({
    region: S3_REGION,
    endpoint: S3_ENDPOINT,
    forcePathStyle: true,
    credentials: { accessKeyId: S3_ACCESS, secretAccessKey: S3_SECRET },
  })
  const buckets = new Set<string>()
  const bucketFor = async (m: Mount): Promise<string> => {
    const name = `mirage-integ-${id}-${String(m.bucket)}`
    if (!buckets.has(name)) {
      await client.send(new CreateBucketCommand({ Bucket: name }))
      buckets.add(name)
    }
    return name
  }
  // Bucket names resolve once (creating them on the way); building the mounts
  // is then pure, so a shadow workspace can be built over the same buckets.
  const resolved: [string, Mount][] = []
  for (const m of target.mounts) resolved.push([await bucketFor(m), m])
  const build = (): MountMap => {
    const mounts: Record<string, S3Resource> = {}
    for (const [bucket, m] of resolved) {
      mounts[m.path] = objectStorageResource(m.resource, bucket, m.prefix)
    }
    return mounts
  }
  const opened = openWorkspaces(build, options)
  const cleanup = async (): Promise<void> => {
    await opened.closeAll()
    for (const bucket of buckets) {
      let token: string | undefined
      do {
        const listed = await client.send(
          new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }),
        )
        for (const obj of listed.Contents ?? []) {
          if (obj.Key) await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: obj.Key }))
        }
        token = listed.IsTruncated ? listed.NextContinuationToken : undefined
      } while (token)
      await client.send(new DeleteBucketCommand({ Bucket: bucket }))
    }
    client.destroy()
  }
  return { ws: opened.ws, shadow: opened.shadow, cleanup }
}

function nextcloudMountUrl(root: string | undefined): string {
  if (NEXTCLOUD_URL === undefined || NEXTCLOUD_URL === '') {
    throw new Error('nextcloud target requires NEXTCLOUD_URL')
  }
  const base = NEXTCLOUD_URL.endsWith('/') ? NEXTCLOUD_URL : `${NEXTCLOUD_URL}/`
  const relative = (root ?? '')
    .split('/')
    .filter((part) => part !== '')
    .map(encodeURIComponent)
    .join('/')
  return relative !== '' ? `${base}${relative}/` : base
}

async function openNextcloud(target: Target): Promise<Open> {
  const mounts: Record<string, NextcloudResource> = {}
  for (const mount of target.mounts) {
    mounts[mount.path] = new NextcloudResource({
      url: nextcloudMountUrl(mount.root),
      username: NEXTCLOUD_USERNAME,
      password: NEXTCLOUD_PASSWORD,
    })
  }
  const ws = new Workspace(mounts, { mode: MountMode.WRITE })
  return { ws: ws as unknown as ExecWorkspace, cleanup: () => ws.close() }
}

const EMAIL_IMAP_PORT = Number(process.env.EMAIL_IMAP_PORT ?? '3143')
const EMAIL_SMTP_PORT = Number(process.env.EMAIL_SMTP_PORT ?? '3025')
const EMAIL_USERNAME = 'integ@example.com'
// Two more accounts. The mount keeps the primary; the renamed CLI installs h1
// and h2 hold these two, so the mount and the CLIs never share an account.
const EMAIL_USERNAME_ALPHA = 'alpha@example.com'
const EMAIL_USERNAME_BETA = 'beta@example.com'
// The tenants the fake seeds, which are the local parts of the three addresses
// above. One served domain, so the local part is the whole identity.
const EMAIL_ACCOUNTS = ['integ', 'alpha', 'beta']
// The directory the shared mail manifest lives in, and the one the fake expands
// from. A target names `email/v1`; the fake takes fixture NAMES, never paths,
// so the prefix is checked off here rather than passed through.
const EMAIL_MANIFEST_DIR = 'email'

function emailManifestName(mail: string): string {
  const prefix = `${EMAIL_MANIFEST_DIR}/`
  if (!mail.startsWith(prefix)) {
    throw new Error(`email target mail=${mail} must live under ${prefix}`)
  }
  return mail.slice(prefix.length)
}
// Doubles as the workspace id on the fake notion server.
const NOTION_TOKEN = 'integ-test'

// The mail fake is external and shared, and it is not GreenMail: the IMAP
// PASSWORD is the run, so two runs log in at the same address with the same
// username and see different mail. GreenMail cannot do that at all -- one
// account is one mailbox for every caller of the process -- which is why a run
// had to purge the whole server between targets and why the two hosts could
// never share one.
//
// Seeding is server-side. The fake reads the same shared manifest this adapter
// used to walk, so there is no IMAP APPEND loop here and no account
// provisioning: one POST states the accounts and the scenario.
async function openEmail(target: Target): Promise<Open> {
  const host = process.env.EMAIL_HOST
  if (host === undefined || host === '') throw new Error('email target requires EMAIL_HOST')
  const base = process.env.MAIL_URL
  if (base === undefined || base === '') throw new Error('email target requires MAIL_URL')
  // The run id, which every account authenticates with. Harness-side on both
  // arms and in no task file, exactly as the mount password was.
  const password = runId()
  const body: Record<string, unknown> = { tenants: EMAIL_ACCOUNTS }
  if (target.mail !== undefined) {
    body.extras = { manifest: emailManifestName(target.mail) }
  }
  const reset = await fetch(`${base.replace(/\/$/, '')}/_run/${password}/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!reset.ok) throw new Error(`mail reset failed: ${String(reset.status)}`)
  const mounts: Record<string, EmailResource | RAMResource> = {}
  for (const m of target.mounts) {
    if (m.resource === 'ram') {
      mounts[m.path] = new RAMResource()
      continue
    }
    mounts[m.path] = new EmailResource({
      imapHost: host,
      imapPort: EMAIL_IMAP_PORT,
      smtpHost: host,
      smtpPort: EMAIL_SMTP_PORT,
      username: EMAIL_USERNAME,
      password,
      useSsl: false,
      maxMessages: 200,
    })
  }
  const ws = new Workspace(mounts, { mode: MountMode.WRITE, ...permissionOptions(target) })
  // Every registerCli in this file installs the same snake_case block
  // the Python runner does, so the cli facet proves one YAML config
  // serves both hosts rather than only that each host has some config
  // it accepts. The registry camelizes onto declared fields.
  // h1 and h2 are the same spec installed twice: two head words, two
  // accounts, and neither shares the mount's account, so a line's
  // behavior proves which config it ran under.
  const integ = {
    imap_host: host,
    imap_port: EMAIL_IMAP_PORT,
    smtp_host: host,
    smtp_port: EMAIL_SMTP_PORT,
    username: EMAIL_USERNAME,
    password,
    use_ssl: false,
  }
  const alpha = { ...integ, username: EMAIL_USERNAME_ALPHA }
  const beta = { ...integ, username: EMAIL_USERNAME_BETA }
  const installs: Record<string, Record<string, unknown>> = {
    himalaya: integ,
    h1: alpha,
    h2: beta,
  }
  for (const name of target.clis ?? []) {
    const config = installs[name]
    if (config === undefined) throw new Error(`email target: unknown cli ${name}`)
    ws.registerCli(name, HIMALAYA, config)
  }
  return { ws: ws as unknown as ExecWorkspace, cleanup: () => ws.close() }
}

async function openHf(target: Target, options?: OpenOptions): Promise<Open> {
  let endpoint = process.env.HF_URL ?? ''
  while (endpoint.endsWith('/')) endpoint = endpoint.slice(0, -1)
  if (endpoint === '') throw new Error('hf target requires HF_URL')
  // Each run takes its own ACCOUNT on the shared fake. The client sends the
  // user's token verbatim on every Hub call, so the token IS the account,
  // which replaces naming the bucket `integ/<runid>-<mount>` inside one shared
  // process: that isolated runs only as far as a name collision, and a bucket
  // named after the run is not a name any real deployment would carry.
  const token = `integ-hf-${runId()}`
  const build = (): MountMap => {
    const mounts: Record<string, HfBucketsResource> = {}
    for (const m of target.mounts) {
      // Buckets auto-create on first touch, exactly as a real one does for a
      // namespace the token owns.
      mounts[m.path] = new HfBucketsResource({
        bucket: `integ/${String(m.bucket)}`,
        token,
        endpoint,
        keyPrefix: m.prefix,
      })
    }
    return mounts
  }
  const opened = openWorkspaces(build, options)
  return { ws: opened.ws, shadow: opened.shadow, cleanup: opened.closeAll }
}

async function openHfHub(target: Target): Promise<Open> {
  let endpoint = process.env.HF_HUB_URL ?? ''
  while (endpoint.endsWith('/')) endpoint = endpoint.slice(0, -1)
  if (endpoint === '') throw new Error('hf-hub target requires HF_HUB_URL')
  // The token IS the tenant here, as it is for the hf buckets fake: the client
  // sends it verbatim on every Hub call and the fake reads it off
  // Authorization, so a per-run token isolates two runs against one server.
  const token = `integ-hfhub-${runId()}`
  // Not optional, unlike every object-store fake here. A Hub mount NAMES a
  // repository and mounting never creates one, so the repositories the target
  // mounts have to exist before the mount is built. File CONTENT still arrives
  // the ordinary way, through each mount's own `fixture:` seed, which writes
  // over the resource's commit path rather than behind it.
  const reset = await fetch(`${endpoint}/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenants: [token], fixture: 'v1' }),
  })
  if (!reset.ok) throw new Error(`hf-hub /reset failed: ${String(reset.status)}`)
  const mounts: Record<
    string,
    HfModelsResource | HfDatasetsResource | HfSpacesResource | RAMResource
  > = {}
  for (const m of target.mounts) {
    if (m.resource === 'ram') {
      mounts[m.path] = new RAMResource()
      continue
    }
    // A Hub mount NAMES a repository, so an absent one is a broken target
    // rather than a default: `repoId: ''` would reach the fake as a request
    // for the repository called nothing.
    if (m.repo === undefined) throw new Error(`hf-hub mount ${m.path} needs a repo`)
    const config = {
      repoId: m.repo,
      token,
      endpoint,
      ...(m.prefix !== undefined ? { keyPrefix: m.prefix } : {}),
    }
    // Every kind is named, and an unrecognized one throws. The three differ
    // only by the `repo_type` they send, so falling back to models for an
    // unknown name does not fail: it silently exercises the wrong endpoints
    // and reports the models implementation as the one under test.
    const kinds = {
      hf_models: HfModelsResource,
      hf_datasets: HfDatasetsResource,
      hf_spaces: HfSpacesResource,
    }
    const kind = kinds[m.resource as keyof typeof kinds] as
      | (new (c: typeof config) => HfModelsResource | HfDatasetsResource | HfSpacesResource)
      | undefined
    if (kind === undefined) throw new Error(`hf-hub cannot mount ${m.resource}`)
    mounts[m.path] = new kind(config)
  }
  const ws = new Workspace(mounts, { mode: MountMode.WRITE })
  if (target.clis?.includes('hf') === true) {
    ws.registerCli('hf', HF, { token, endpoint })
  }
  return { ws: ws as unknown as ExecWorkspace, cleanup: () => ws.close() }
}

// The seeding calls have to reach the SAME account the mount will read, and
// on this fake the account is the bearer token, so it is a parameter rather
// than a constant.
const boxAuth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` })

async function boxCreateWebLink(
  endpoint: string,
  token: string,
  parentId: string,
  name: string,
  url: string,
): Promise<void> {
  const r = await fetch(`${endpoint}/2.0/web_links`, {
    method: 'POST',
    headers: { ...boxAuth(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, url, parent: { id: parentId } }),
  })
  if (r.status !== 201) throw new Error(`box web_link seed failed: ${String(r.status)}`)
}

async function boxCreateFolder(
  endpoint: string,
  token: string,
  parentId: string,
  name: string,
): Promise<string> {
  const r = await fetch(`${endpoint}/2.0/folders`, {
    method: 'POST',
    headers: { ...boxAuth(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, parent: { id: parentId } }),
  })
  if (r.status === 201) return ((await r.json()) as { id: string }).id
  if (r.status === 409) {
    const list = await fetch(`${endpoint}/2.0/folders/${parentId}/items?limit=1000`, {
      headers: boxAuth(token),
    })
    const items = ((await list.json()) as { entries: { id: string; name: string; type: string }[] })
      .entries
    const hit = items.find((e) => e.type === 'folder' && e.name === name)
    if (hit) return hit.id
  }
  throw new Error(`box folder create ${name} -> ${String(r.status)}`)
}

async function boxUpload(
  endpoint: string,
  token: string,
  folderId: string,
  name: string,
  content: Uint8Array,
): Promise<void> {
  const form = new FormData()
  form.set('attributes', JSON.stringify({ name, parent: { id: folderId } }))
  form.set('file', new Blob([content]), name)
  const r = await fetch(`${endpoint}/2.0/files/content`, {
    method: 'POST',
    headers: boxAuth(token),
    body: form,
  })
  if (r.status !== 201) throw new Error(`box upload ${name} -> ${String(r.status)}`)
}

async function openBox(target: Target): Promise<Open> {
  let endpoint = process.env.BOX_URL ?? ''
  while (endpoint.endsWith('/')) endpoint = endpoint.slice(0, -1)
  if (endpoint === '') throw new Error('box target requires BOX_URL')
  // Each run takes its own ACCOUNT on the shared fake. The vendor's
  // developer-token flow sends a pre-fetched access token verbatim, so the
  // token IS the account and no mirage-only header is involved. This replaces
  // naming the mount folder `integ-<runid>-<mount>` inside one shared account,
  // which isolated runs only as far as a name collision.
  const token = `integ-box-${runId()}`
  const root = integRoot()
  const mounts: Record<string, BoxResource> = {}
  for (const m of target.mounts) {
    // Box is read-only through the workspace, so the harness tee-seeding
    // can't run; the fixture is uploaded over the Box API instead (the folder
    // id becomes the mount root, mirroring how a real Box app scopes to a
    // folder).
    const folderId = await boxCreateFolder(endpoint, token, '0', String(m.folder))
    if (m.seed !== undefined) {
      const base = join(root, 'fixtures', m.seed)
      for (const file of walkFiles(base)) {
        const rel = relative(base, file).split(sep).join('/')
        const parts = rel.split('/')
        let parentId = folderId
        for (const dir of parts.slice(0, -1)) {
          parentId = await boxCreateFolder(endpoint, token, parentId, dir)
        }
        await boxUpload(
          endpoint,
          token,
          parentId,
          parts[parts.length - 1] ?? '',
          new Uint8Array(readFileSync(file)),
        )
      }
    }
    if (m.seed === 'files/v1') {
      // A weblink beside the fixture: sizeless and content-free, so
      // listings must hide it and a direct stat must ENOENT.
      await boxCreateWebLink(endpoint, token, folderId, 'homepage', 'https://example.com/')
    }
    mounts[m.path] = new BoxResource({
      accessToken: token,
      endpoint,
      rootFolderId: folderId,
      // The fake supports name+content search, so exercise grep/rg push-down
      // narrowing in the battery.
      contentSearch: true,
    })
  }
  const ws = new Workspace(mounts, { mode: MountMode.WRITE })
  return { ws: ws as unknown as ExecWorkspace, cleanup: () => ws.close() }
}

async function openDropbox(target: Target, options?: OpenOptions): Promise<Open> {
  // Mounts sharing a `bucket` share one fake ACCOUNT (the -root target mounts
  // three rootPath subfolders of a single account, mirroring s3-prefix's
  // shared bucket); distinct buckets get isolated accounts. An account is a
  // tenant on the one shared server rather than a server of its own: the fake
  // echoes the refresh token back from /oauth2/token as the access token, so
  // the account rides the ordinary Authorization header the Dropbox RPC layer
  // already sends. The run id is part of the token so two runs against the
  // same shared server cannot see each other's writes.
  let endpoint = process.env.DROPBOX_URL ?? ''
  while (endpoint.endsWith('/')) endpoint = endpoint.slice(0, -1)
  if (endpoint === '') throw new Error('dropbox target requires DROPBOX_URL')
  const id = runId()
  const build = (): MountMap => {
    const mounts: Record<string, DropboxResource> = {}
    for (const m of target.mounts) {
      const account = String(m.bucket ?? String(m.path).replace(/^\/+|\/+$/g, ''))
      mounts[m.path] = new DropboxResource({
        clientId: 'integ-client',
        clientSecret: 'integ-secret',
        refreshToken: `${id}-${account}`,
        // The fake supports full-text search_v2, so exercise grep/rg
        // narrowing in the battery.
        contentSearch: true,
        endpoint,
        ...(m.root !== undefined ? { rootPath: m.root } : {}),
      })
    }
    return mounts
  }
  const opened = openWorkspaces(build, options)
  return { ws: opened.ws, shadow: opened.shadow, cleanup: () => opened.closeAll() }
}

// The Graph service root, shared by the onedrive and the sharepoint targets:
// OneDrive for Business is SharePoint underneath and one fake serves both.
// This used to be a PYTHON SUBPROCESS started from the TypeScript runner, one
// per target; it is now the same external Prisma-backed server the python host
// talks to.
function graphBase(): string {
  let base = process.env.ONEDRIVE_URL ?? ''
  while (base.endsWith('/')) base = base.slice(0, -1)
  if (base === '') throw new Error('onedrive target requires ONEDRIVE_URL')
  return base
}

// Which drives a SharePoint site has is deployment state, and real Graph has
// no endpoint that creates one, so the fake takes a declaration on a route of
// its own. It replaces the `MIRAGE_GRAPH_DRIVES` env the subprocess read at
// launch, which a shared server cannot have: the drives belong to this run's
// account, not to the process.
async function declareDrive(base: string, token: string, drive: string): Promise<void> {
  const resp = await fetch(`${base}/drives/${encodeURIComponent(drive)}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!resp.ok) throw new Error(`sharepoint drive ${drive} -> ${String(resp.status)}`)
}

async function makePrefix(
  base: string,
  token: string,
  drive: string,
  prefix: string,
): Promise<void> {
  let parent = ''
  for (const name of prefix.replace(/^\/+|\/+$/g, '').split('/')) {
    if (name === '') continue
    // One level at a time: Graph's mkdir 404s when the parent is missing, and
    // `replace` on a folder returns the existing one with its children intact,
    // which is what makes this idempotent across the two mounts of
    // sharepoint-prefix that share a `team/reports` ancestor.
    const stem = `${base}/drives/${encodeURIComponent(drive)}/root`
    const url = parent === '' ? `${stem}/children` : `${stem}:/${parent}:/children`
    const resp = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        folder: {},
        '@microsoft.graph.conflictBehavior': 'replace',
      }),
    })
    if (!resp.ok) throw new Error(`sharepoint mkdir ${name} -> ${String(resp.status)}`)
    parent = parent === '' ? name : `${parent}/${name}`
  }
}

async function openOneDrive(target: Target, options?: OpenOptions): Promise<Open> {
  // Each target takes its own Graph ACCOUNT, carried by the access token the
  // client already sends on every call, so two runs against the one shared
  // server cannot see each other's writes.
  const base = graphBase()
  const token = `${runId()}-${target.id}`
  const build = (): MountMap => {
    const mounts: Record<string, OneDriveResource> = {}
    for (const mount of target.mounts) {
      mounts[mount.path] = new OneDriveResource({
        accessToken: token,
        graphBaseUrl: base,
        ...(mount.prefix !== undefined ? { keyPrefix: mount.prefix } : {}),
      })
    }
    return mounts
  }
  const opened = openWorkspaces(build, options)
  return { ws: opened.ws, shadow: opened.shadow, cleanup: () => opened.closeAll() }
}

async function openSharePoint(target: Target, options?: OpenOptions): Promise<Open> {
  const base = graphBase()
  const token = `${runId()}-${target.id}`
  for (const mount of target.mounts) {
    const drive = String(mount.drive)
    await declareDrive(base, token, drive)
    if (mount.prefix !== undefined) await makePrefix(base, token, drive, mount.prefix)
  }
  const build = (): MountMap => {
    const mounts: Record<string, SharePointResource> = {}
    for (const mount of target.mounts) {
      mounts[mount.path] = new SharePointResource({
        accessToken: token,
        graphBaseUrl: base,
        site: 'Main',
        drive: mount.drive,
        ...(mount.prefix !== undefined ? { keyPrefix: mount.prefix } : {}),
      })
    }
    return mounts
  }
  const opened = openWorkspaces(build, options)
  return { ws: opened.ws, shadow: opened.shadow, cleanup: () => opened.closeAll() }
}

async function openNotion(target: Target): Promise<Open> {
  let base = process.env.NOTION_URL ?? ''
  while (base.endsWith('/')) base = base.slice(0, -1)
  if (base === '') throw new Error('notion target requires NOTION_URL')
  // The TOKEN is not minted per run, and notion is the only kit fake whose
  // token cannot be. It is OBSERVABLE: `ntn auth token` prints the CLI's
  // configured value without contacting the server at all, integ/cli/ntn.json
  // pins that literal, and integ/ntn_conformance.ts asserts the same line
  // against the real ntn binary configured with the same fixed token. A
  // per-run token makes the battery print one value and the conformance run
  // another, with one golden between them.
  //
  // So the RUN separates the two hosts instead, riding the base URL as a
  // leading `/_run/<id>` segment. That is the only channel available here: the
  // mount hands this URL to NotionResource and never sees the request, so a
  // header or a `?_run=` query would have to be threaded through the resource.
  // Each host now gets its own SQLite file under the one shared token, and the
  // two can reset concurrently instead of taking turns.
  const token = NOTION_TOKEN
  const scoped = `${base}/_run/${runId()}`
  const reset = await fetch(`${scoped}/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenants: [token] }),
  })
  if (!reset.ok) throw new Error(`notion /reset failed: ${String(reset.status)}`)
  const mounts: Record<string, NotionResource | RAMResource | [NotionResource, MountMode]> = {}
  for (const mount of target.mounts) {
    if (mount.resource === 'ram') {
      mounts[mount.path] = new RAMResource()
      continue
    }
    const resource = new NotionResource({
      apiKey: token,
      baseUrl: `${scoped}/v1`,
    })
    mounts[mount.path] = mount.mode === 'read' ? [resource, MountMode.READ] : resource
  }
  const ws = new Workspace(mounts, { mode: MountMode.WRITE })
  if (target.clis?.includes('ntn') === true) {
    // The same run as the mounts above. The CLI and the mount are two views of
    // one workspace, so pointing them at different runs would give a case that
    // writes with `ntn` and reads through /notion two different worlds.
    ws.registerCli('ntn', NTN, {
      api_key: token,
      base_url: `${scoped}/v1`,
    })
  }
  const cleanup = async (): Promise<void> => {
    await ws.close()
  }
  return { ws: ws as unknown as ExecWorkspace, cleanup }
}

const LANCEDB_ROWS: ReadonlyArray<Record<string, unknown>> = [
  { id: 1, label: 'cat', kind: 'big', name: 'a big orange cat' },
  { id: 2, label: 'cat', kind: 'small', name: 'a small grey cat' },
  { id: 3, label: 'dog', kind: 'big', name: 'a big brown dog' },
  { id: 4, label: 'dog', kind: 'small', name: 'a small white dog' },
]

// One group holding far more rows than the window facet's row cap, so a glob
// for a row past the cap can only be answered by narrowing the query.
const LANCEDB_WIDE_CAP = 5

function lancedbWideRows(): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = []
  for (let i = 0; i < 40; i += 1) {
    rows.push({ id: `doc-${String(i).padStart(3, '0')}`, label: 'all', name: `row ${String(i)}` })
  }
  return rows
}

async function openLancedb(target: Target): Promise<Open> {
  const window = target.facet === 'window'
  const uri = mkdtempSync(join(tmpdir(), 'mirage-integ-lancedb-'))
  const db = await lancedb.connect(uri)
  if (window) await db.createTable('wide', lancedbWideRows())
  else await db.createTable('animals', LANCEDB_ROWS as Record<string, unknown>[])
  const mounts: Record<string, LanceDBResource | [LanceDBResource, MountMode]> = {}
  for (const mount of target.mounts) {
    const resource = window
      ? new LanceDBResource({
          uri,
          table: 'wide',
          groupBy: ['label'],
          idColumn: 'id',
          titleColumn: 'name',
          textColumn: 'name',
          maxRows: LANCEDB_WIDE_CAP,
        })
      : new LanceDBResource({
          uri,
          groupBy: ['label', 'kind'],
          idColumn: 'id',
          titleColumn: 'name',
          textColumn: 'name',
        })
    mounts[mount.path] = mount.mode === 'read' ? [resource, MountMode.READ] : resource
  }
  const ws = new Workspace(mounts, { mode: MountMode.WRITE })
  const cleanup = async (): Promise<void> => {
    await ws.close()
    rmSync(uri, { recursive: true, force: true })
  }
  return { ws: ws as unknown as ExecWorkspace, cleanup }
}

const QDRANT_EMBED_DIM = 8

const QDRANT_ROWS: ReadonlyArray<readonly [number, string, string, string]> = [
  [1, 'cat', 'big', 'a big orange cat'],
  [2, 'cat', 'small', 'a small grey cat'],
  [3, 'dog', 'big', 'a big brown dog'],
  [4, 'dog', 'small', 'a small white dog'],
]

// Far more points than the window facet's row cap, all in one group, and ids
// whose text straddles a scroll page so a narrowed listing has to page.
const QDRANT_WIDE_CAP = 5
const QDRANT_WIDE_POINTS = 600

async function openQdrant(target: Target): Promise<Open> {
  const window = target.facet === 'window'
  const host = process.env.QDRANT_HOST ?? 'localhost'
  const port = Number.parseInt(process.env.QDRANT_PORT ?? '6333', 10)
  const collection = `mirage-integ-${runId()}`
  const client = new QdrantClient({ host, port })
  await client.createCollection(collection, {
    vectors: { size: QDRANT_EMBED_DIM, distance: 'Cosine' },
  })
  if (window) {
    const points = []
    for (let i = 1; i <= QDRANT_WIDE_POINTS; i += 1) {
      points.push({
        id: i,
        vector: Array<number>(QDRANT_EMBED_DIM).fill(0.1),
        payload: { label: 'all', name: `row ${String(i)}` },
      })
    }
    await client.upsert(collection, { points })
  } else {
    await client.upsert(collection, {
      points: QDRANT_ROWS.map(([id, label, kind, name]) => ({
        id,
        vector: Array<number>(QDRANT_EMBED_DIM).fill(0.1),
        payload: { label, kind, name, image_bytes: btoa(`PNG-${String(id)}`) },
      })),
    })
  }
  for (const field of window ? ['label'] : ['label', 'kind']) {
    await client.createPayloadIndex(collection, { field_name: field, field_schema: 'keyword' })
  }
  await new Promise((r) => setTimeout(r, 2000))
  const mounts: Record<string, QdrantResource | [QdrantResource, MountMode]> = {}
  for (const mount of target.mounts) {
    const resource = window
      ? new QdrantResource({
          host,
          port,
          collection,
          groupBy: ['label'],
          idField: 'id',
          textField: 'name',
          maxRows: QDRANT_WIDE_CAP,
        })
      : new QdrantResource({
          host,
          port,
          collection,
          groupBy: ['label', 'kind'],
          idField: 'id',
          textField: 'name',
          blobField: 'image_bytes',
          blobExt: 'png',
        })
    mounts[mount.path] = mount.mode === 'read' ? [resource, MountMode.READ] : resource
  }
  const ws = new Workspace(mounts, { mode: MountMode.WRITE })
  const cleanup = async (): Promise<void> => {
    await ws.close()
    await new QdrantClient({ host, port }).deleteCollection(collection)
  }
  return { ws: ws as unknown as ExecWorkspace, cleanup }
}

const CHROMA_EMBED_DIM = 8

interface ChromaChunk {
  document: string
  metadata: { page_slug: string; chunk_index: number }
}

interface ChromaSeed {
  path_tree: Record<string, unknown>
  chunks: Record<string, ChromaChunk[]>
}

function chromaEmbedding(position: number): number[] {
  const vector = new Array<number>(CHROMA_EMBED_DIM).fill(0)
  vector[position % CHROMA_EMBED_DIM] = 1
  return vector
}

async function seedChroma(host: string, port: number, collectionName: string): Promise<void> {
  const seed = JSON.parse(
    readFileSync(join(integRoot(), 'server', 'chroma_seed.json'), 'utf8'),
  ) as ChromaSeed
  const encoded = gzipSync(Buffer.from(JSON.stringify(seed.path_tree))).toString('base64')
  const ids = ['__path_tree__']
  const documents = [encoded]
  const metadatas: Record<string, string | number>[] = [{ kind: 'path_tree' }]
  const embeddings = [chromaEmbedding(0)]
  let position = 1
  for (const chunks of Object.values(seed.chunks)) {
    for (const chunk of chunks) {
      ids.push(`${chunk.metadata.page_slug}#${String(chunk.metadata.chunk_index)}`)
      documents.push(chunk.document)
      metadatas.push(chunk.metadata)
      embeddings.push(chromaEmbedding(position))
      position += 1
    }
  }
  const client = new ChromaClient({ host, port })
  const collection = await client.createCollection({
    name: collectionName,
    embeddingFunction: null,
  })
  await collection.add({ ids, documents, metadatas, embeddings })
}

async function openChroma(target: Target): Promise<Open> {
  const host = process.env.CHROMA_HOST ?? 'localhost'
  const port = Number.parseInt(process.env.CHROMA_PORT ?? '8000', 10)
  const collectionName = `mirage-integ-${runId()}`
  await seedChroma(host, port, collectionName)
  const mounts: Record<string, ChromaResource | [ChromaResource, MountMode]> = {}
  for (const mount of target.mounts) {
    const resource = new ChromaResource({ host, port, collectionName })
    mounts[mount.path] = mount.mode === 'read' ? [resource, MountMode.READ] : resource
  }
  const ws = new Workspace(mounts, { mode: MountMode.WRITE })
  const cleanup = async (): Promise<void> => {
    await ws.close()
    await new ChromaClient({ host, port }).deleteCollection({ name: collectionName })
  }
  return { ws: ws as unknown as ExecWorkspace, cleanup }
}

const MONGODB_DB = 'mirage_integ'

const MONGODB_BOOKS: ReadonlyArray<Record<string, unknown>> = [
  { _id: 1, title: 'alpha', author: 'ada', year: 2020, tags: ['fiction', 'classic'], rating: 4.5 },
  { _id: 2, title: 'beta', author: 'ben', year: 2021, tags: ['fiction'], rating: 3.2 },
  { _id: 3, title: 'gamma', author: 'cara', year: 2022, rating: 5.0 },
  { _id: 4, title: 'delta', author: 'ada', year: 2023, tags: ['history'], rating: 4.0 },
  { _id: 5, title: 'epsilon', author: 'ben', year: 2024, rating: 2.5 },
]

const MONGODB_AUTHORS: ReadonlyArray<Record<string, unknown>> = [
  { _id: 1, name: 'ada', books: 2 },
  { _id: 2, name: 'ben', books: 2 },
  { _id: 3, name: 'cara', books: 1 },
]

async function seedMongodb(uri: string): Promise<void> {
  const client = new MongoClient(uri)
  await client.connect()
  try {
    const db = client.db(MONGODB_DB)
    await db.dropDatabase()
    // Python seeds floats (BSON double); insert Double so the inferred schema
    // and rendered documents match byte-for-byte across languages.
    await db
      .collection('books')
      .insertMany(MONGODB_BOOKS.map((d) => ({ ...d, rating: new Double(d.rating as number) })))
    await db.collection('authors').insertMany(MONGODB_AUTHORS.map((d) => ({ ...d })))
    await db.createCollection('recent_books', {
      viewOn: 'books',
      pipeline: [{ $match: { year: { $gte: 2022 } } }],
    })
  } finally {
    await client.close()
  }
}

async function openMongodb(target: Target): Promise<Open> {
  const uri = process.env.MONGODB_URI
  if (uri === undefined) throw new Error('mongodb target requires MONGODB_URI')
  await seedMongodb(uri)
  const resources: MongoDBResource[] = []
  const mounts: Record<string, MongoDBResource | [MongoDBResource, MountMode]> = {}
  for (const mount of target.mounts) {
    const resource = new MongoDBResource({ uri, databases: [MONGODB_DB] })
    resources.push(resource)
    mounts[mount.path] = mount.mode === 'read' ? [resource, MountMode.READ] : resource
  }
  const ws = new Workspace(mounts, { mode: MountMode.WRITE })
  const cleanup = async (): Promise<void> => {
    await ws.close()
    for (const resource of resources) await resource.close()
  }
  return { ws: ws as unknown as ExecWorkspace, cleanup }
}

const POSTGRES_BOOKS: ReadonlyArray<readonly [number, string, string, number, number]> = [
  [1, 'alpha', 'ada', 2020, 4.5],
  [2, 'beta', 'ben', 2021, 3.2],
  [3, 'gamma', 'cara', 2022, 5.0],
  [4, 'delta', 'ada', 2023, 4.0],
  [5, 'epsilon', 'ben', 2024, 2.5],
]

const POSTGRES_AUTHORS: ReadonlyArray<readonly [number, string, number]> = [
  [1, 'ada', 2],
  [2, 'ben', 2],
  [3, 'cara', 1],
]

async function seedPostgres(dsn: string): Promise<void> {
  const client = new pg.Client({ connectionString: dsn })
  await client.connect()
  try {
    await client.query('DROP VIEW IF EXISTS recent_books')
    await client.query('DROP TABLE IF EXISTS books')
    await client.query('DROP TABLE IF EXISTS authors')
    await client.query(
      'CREATE TABLE books (id int PRIMARY KEY, title text, author text, year int, rating double precision)',
    )
    await client.query('CREATE TABLE authors (id int PRIMARY KEY, name text, books int)')
    for (const [id, title, author, year, rating] of POSTGRES_BOOKS) {
      await client.query(
        'INSERT INTO books (id, title, author, year, rating) VALUES ($1, $2, $3, $4, $5)',
        [id, title, author, year, rating],
      )
    }
    for (const [id, name, books] of POSTGRES_AUTHORS) {
      await client.query('INSERT INTO authors (id, name, books) VALUES ($1, $2, $3)', [
        id,
        name,
        books,
      ])
    }
    await client.query('CREATE VIEW recent_books AS SELECT * FROM books WHERE year >= 2022')
    await client.query('ANALYZE books')
    await client.query('ANALYZE authors')
    // A quoted dot-prefixed schema is legal; the kit must keep it out of
    // listings, not advertise a path stat reports absent.
    await client.query('DROP SCHEMA IF EXISTS ".hidden" CASCADE')
    await client.query('CREATE SCHEMA ".hidden"')
    await client.query('CREATE TABLE ".hidden".ghost (id int PRIMARY KEY)')
  } finally {
    await client.end()
  }
}

async function openPostgres(target: Target): Promise<Open> {
  const dsn = process.env.POSTGRES_DSN
  if (dsn === undefined) throw new Error('postgres target requires POSTGRES_DSN')
  await seedPostgres(dsn)
  const resources: PostgresResource[] = []
  const mounts: Record<string, PostgresResource | [PostgresResource, MountMode]> = {}
  for (const mount of target.mounts) {
    const resource = new PostgresResource({ dsn, maxReadRows: 200 })
    resources.push(resource)
    mounts[mount.path] = mount.mode === 'read' ? [resource, MountMode.READ] : resource
  }
  const ws = new Workspace(mounts, { mode: MountMode.WRITE })
  const cleanup = async (): Promise<void> => {
    await ws.close()
    for (const resource of resources) await resource.close()
  }
  return { ws: ws as unknown as ExecWorkspace, cleanup }
}

// No subprocess: the fake is a kit fake now and this host is already a node
// process, so it starts in-process on an ephemeral port. That is one fewer
// interpreter hop than spawning it, and `close` disposes the SQLite pool too.
async function openMem0(target: Target): Promise<Open> {
  // Imported here rather than at the top of the file, because this module is
  // loaded for every target and a kit fake's module reaches its generated
  // Prisma client at import time. A static import would make `--target
  // nextcloud` fail on a job that has no reason to generate the mem0 client.
  // Any future in-process fake belongs behind the same lazy import.
  const { mem0Fake } = await import('../../../server/mem0/fake.ts')
  const server = await startKitFake(mem0Fake)
  const mounts: Record<string, Mem0Resource> = {}
  for (const mount of target.mounts) {
    mounts[mount.path] = new Mem0Resource({
      apiKey: 'integ-key',
      host: server.endpoint,
      userId: 'integ-user',
      defaultPageSize: 2,
    })
  }
  const ws = new Workspace(mounts, { mode: MountMode.WRITE })
  const cleanup = async (): Promise<void> => {
    await ws.close()
    await server.close()
  }
  return { ws: ws as unknown as ExecWorkspace, cleanup }
}

async function adminExec(ws: Workspace, command: string): Promise<void> {
  const result = await ws.execute(command)
  if (result.exitCode !== 0) {
    throw new Error(`admin command failed: ${command}: ${new TextDecoder().decode(result.stderr)}`)
  }
}

async function openSsh(target: Target, options?: OpenOptions): Promise<Open> {
  const host = process.env.SSH_HOST
  if (!host) throw new Error('ssh target requires SSH_HOST')
  const port = Number(process.env.SSH_PORT ?? '22')
  const base = `mirage-integ-${runId()}`
  const adminResource = new SSHResource({ host, port, username: 'integ' })
  const admin = new Workspace({ '/admin': adminResource }, { mode: MountMode.WRITE })
  const paths = target.mounts.map((m) => `/admin/${base}/${String(m.root)}`).join(' ')
  await adminExec(admin, `mkdir -p ${paths}`)
  // A server-side symlink in the /links mount: mirage's shell ln -s only
  // makes namespace links, so the battery needs one created over SFTP to
  // pin that ssh stat follows links (target size, not link-text length).
  // Dangling until the fixture seeds poem.txt.
  const sftp = await adminResource.accessor.sftp()
  for (const m of target.mounts) {
    if (m.root !== 'links') continue
    await new Promise<void>((resolveFn, rejectFn) => {
      sftp.symlink('../data/poem.txt', `/${base}/${String(m.root)}/poem_link.txt`, (err) => {
        if (err !== undefined) rejectFn(err)
        else resolveFn()
      })
    })
  }
  const build = (): MountMap => {
    const mounts: Record<string, SSHResource> = {}
    for (const m of target.mounts) {
      mounts[m.path] = new SSHResource({
        host,
        port,
        username: 'integ',
        root: `/${base}/${String(m.root)}`,
      })
    }
    return mounts
  }
  const opened = openWorkspaces(build, options)
  const cleanup = async (): Promise<void> => {
    await opened.closeAll()
    await adminExec(admin, `rm -rf /admin/${base}`)
    await admin.close()
  }
  return { ws: opened.ws, shadow: opened.shadow, cleanup }
}

const GDRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder'

async function gwsJson(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const r = await fetch(url, init)
  if (!r.ok) throw new Error(`gws fake request failed: ${url} -> ${String(r.status)}`)
  return (await r.json()) as Record<string, unknown>
}

async function gwsFolder(base: string, name: string, parent: string): Promise<string> {
  const q = `name='${name}' and '${parent}' in parents and trashed=false`
  const listed = await gwsJson(`${base}/drive/v3/files?q=${encodeURIComponent(q)}`)
  const files = listed.files as { id: string }[]
  const first = files[0]
  if (first !== undefined) return first.id
  const created = await gwsJson(`${base}/drive/v3/files`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: GDRIVE_FOLDER_MIME, parents: [parent] }),
  })
  return created.id as string
}

// The fake Google Workspace server is external and shared; /reset gives
// each run a clean, deterministic state. Each mount is scoped to a
// per-mount folder via GoogleConfig.folderId, the s3 key_prefix analog.
interface GwsAppEntry {
  kind: 'doc' | 'sheet' | 'slide'
  name: string
  text?: string
  rows?: string[][]
}

// Native files are API objects, not byte blobs, so they seed through the
// same editor APIs the backends speak instead of fixture uploads.
async function seedGwsApps(base: string, entries: GwsAppEntry[]): Promise<void> {
  for (const entry of entries) {
    if (entry.kind === 'doc') {
      const doc = await gwsJson(`${base}/v1/documents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: entry.name }),
      })
      const requests = [{ insertText: { location: { index: 1 }, text: entry.text ?? '' } }]
      await gwsJson(`${base}/v1/documents/${doc.documentId as string}:batchUpdate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests }),
      })
    } else if (entry.kind === 'sheet') {
      const sheet = await gwsJson(`${base}/v4/spreadsheets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ properties: { title: entry.name } }),
      })
      const id = sheet.spreadsheetId as string
      await gwsJson(`${base}/v4/spreadsheets/${id}/values/Sheet1:append`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: entry.rows ?? [] }),
      })
    } else {
      await gwsJson(`${base}/v1/presentations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: entry.name }),
      })
    }
  }
}

interface CalendarEntry {
  summary: string
  // A timed event carries dateTime with a mandatory offset; an all-day one
  // carries a floating date and no zone at all.
  start: { date?: string; dateTime?: string }
  end: { date?: string; dateTime?: string }
}

interface SeedCalendar {
  id: string
  summary: string
  timeZone?: string
  accessRole?: string
  hidden?: boolean
  events?: CalendarEntry[]
}

interface SeedForm {
  title: string
  documentTitle?: string
  description?: string
  items?: Record<string, unknown>[]
  responses?: Record<string, unknown>[]
}

interface CalendarFixture {
  events: CalendarEntry[]
  calendars?: SeedCalendar[]
}

function gwsManifest<T>(name: string | undefined): T | undefined {
  if (name === undefined) return undefined
  return JSON.parse(readFileSync(join(integRoot(), 'fixtures', `${name}.json`), 'utf8')) as T
}

// Messages are API objects: each manifest entry becomes an RFC822 payload
// inserted through messages.insert with internalDateSource=dateHeader, so
// date dirs come from the manifest, not the server clock.
async function seedGwsMail(base: string, entries: MailEntry[]): Promise<void> {
  for (const entry of entries) {
    const raw = Buffer.from(buildRfc822(entry), 'utf-8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
    await gwsJson(`${base}/gmail/v1/users/me/messages?internalDateSource=dateHeader`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw, labelIds: entry.labels ?? [] }),
    })
  }
}

// Events are API objects, so they seed through events.insert and take the
// ids the server mints; the manifest pins the times, which is what the day
// directories are derived from.
async function seedGwsCalendar(base: string, entries: CalendarEntry[]): Promise<void> {
  for (const entry of entries) {
    await gwsJson(`${base}/calendar/v3/calendars/primary/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry),
    })
  }
}

function gwsNativeResource(
  resource: string,
  base: string,
): GDocsResource | GSheetsResource | GSlidesResource | GmailResource | GCalResource {
  // apiBase points the backend at the fake server through the same
  // config field a real embedder uses; nothing is monkey-patched.
  const config = { clientId: 'integ', clientSecret: 'integ', refreshToken: 'integ', apiBase: base }
  if (resource === 'gdocs') return new GDocsResource(config)
  if (resource === 'gsheets') return new GSheetsResource(config)
  if (resource === 'gmail') return new GmailResource(config)
  // today is pinned so the rolling window is the same on both hosts and
  // lands on the seeded events.
  if (resource === 'gcal') return new GCalResource({ ...config, today: '2026-02-11' })
  return new GSlidesResource(config)
}

async function openGws(target: Target): Promise<Open> {
  let base = process.env.GWS_URL ?? ''
  while (base.endsWith('/')) base = base.slice(0, -1)
  if (base === '') throw new Error('gdrive target requires GWS_URL')
  // Every call below goes to this run's own world. gws keeps per-run state
  // already; what it lacked was a way for a mount to ask for one, since a
  // mount hands its base URL to a client and never sees the request. Scoping
  // the base once covers the reset, the drive and folder creation, the seeds
  // and every mount, which is what makes this one line rather than sixteen.
  base = `${base}/_run/${runId()}`
  // Native mounts (gdocs/gsheets/gslides) render the modified date into
  // filenames, so those targets pin the server clock. Secondary calendars
  // and seeded form responses ride the same call rather than being
  // inserted: a calendar's accessRole and a form response are both states
  // no API call can produce. They go under `extras`, the kit's channel for
  // a seed a fixture row cannot state; the base world (system labels, the
  // primary calendar) is fixture rows now that gws seeds through the kit.
  const calendar = gwsManifest<CalendarFixture>(target.calendar)
  const forms = gwsManifest<SeedForm[]>(target.forms)
  const reset: Record<string, unknown> = {}
  const extras: Record<string, unknown> = {}
  if (target.epoch !== undefined) reset.epoch = target.epoch
  if (calendar?.calendars !== undefined) extras.calendars = calendar.calendars
  if (forms !== undefined) extras.forms = forms
  if (Object.keys(extras).length > 0) reset.extras = extras
  await gwsJson(`${base}/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(reset),
  })
  const mounts: Record<
    string,
    GDriveResource | GDocsResource | GSheetsResource | GSlidesResource | GmailResource | RAMResource
  > = {}
  const driveIds: Record<string, string> = {}
  const folderIds: Record<string, string> = {}
  for (const m of target.mounts) {
    if (m.resource === 'ram') {
      mounts[m.path] = new RAMResource()
      continue
    }
    if (m.resource !== 'gdrive') {
      mounts[m.path] = gwsNativeResource(m.resource, base)
      continue
    }
    // A mount may live inside a Shared Drive: the drive is created once
    // per name and its id is the walk's start.
    const drive = m.drive
    if (drive !== undefined && !(drive in driveIds)) {
      const created = (await gwsJson(`${base}/drive/v3/drives`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: drive }),
      })) as { id: string }
      driveIds[drive] = created.id
    }
    let parent = drive !== undefined ? (driveIds[drive] as string) : 'root'
    for (const segment of String(m.root).split('/')) {
      parent = await gwsFolder(base, segment, parent)
    }
    mounts[m.path] = new GDriveResource({
      clientId: 'integ',
      clientSecret: 'integ',
      refreshToken: 'integ',
      apiBase: base,
      folderId: parent,
    })
    folderIds[m.path] = parent
  }
  const apps = gwsManifest<GwsAppEntry[]>(target.apps)
  if (apps !== undefined) await seedGwsApps(base, apps)
  const mail = gwsManifest<MailEntry[]>(target.mail)
  if (mail !== undefined) await seedGwsMail(base, mail)
  if (calendar !== undefined) await seedGwsCalendar(base, calendar.events)
  const ws = new Workspace(mounts, { mode: MountMode.WRITE })
  if (target.clis?.includes('gws') === true) {
    // A target may scope the gws install to one mount's folder, the
    // configuration where the CLI and the mount are the same folder.
    const scope = target.cli_scope
    ws.registerCli('gws', GWS, {
      client_id: 'integ',
      client_secret: 'integ',
      refresh_token: 'integ',
      api_base: base,
      ...(scope !== undefined ? { folder_id: folderIds[scope] } : {}),
    })
  }
  const cleanup = async (): Promise<void> => {
    await ws.close()
  }
  return { ws: ws as unknown as ExecWorkspace, cleanup }
}

// The fake Slack Web API server is external and shared across both hosts;
// /reset re-seeds it to the fixture. A user token (xoxp-) enables the grep/rg
// search push-down against the fake's search.messages / search.files.
async function openSlack(target: Target): Promise<Open> {
  let base = process.env.SLACK_URL ?? ''
  while (base.endsWith('/')) base = base.slice(0, -1)
  if (base === '') throw new Error('slack target requires SLACK_URL')
  // One workspace per run, carried by the token. Both spellings name the same
  // workspace and only the actor type differs: the fake strips that prefix, so
  // search.* (which refuses anything but a user token, exactly as real Slack
  // does) still reaches the same tenant the bot token wrote to.
  const workspace = `integ-${runId()}`
  const reset = await fetch(`${base}/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenants: [workspace] }),
  })
  if (!reset.ok) throw new Error(`slack /reset failed: ${String(reset.status)}`)
  const mounts: Record<string, SlackResource | RAMResource> = {}
  for (const m of target.mounts) {
    if (m.resource === 'ram') {
      mounts[m.path] = new RAMResource()
      continue
    }
    mounts[m.path] = new SlackResource({
      token: `xoxb-${workspace}`,
      searchToken: `xoxp-${workspace}`,
      baseUrl: `${base}/api`,
    })
  }
  const ws = new Workspace(mounts, { mode: MountMode.WRITE })
  if (target.clis?.includes('slack') === true) {
    ws.registerCli('slack', SLACK, {
      token: `xoxb-${workspace}`,
      search_token: `xoxp-${workspace}`,
      base_url: `${base}/api`,
    })
  }
  const cleanup = async (): Promise<void> => {
    await ws.close()
  }
  return { ws: ws as unknown as ExecWorkspace, cleanup }
}

// The repository the `gh` install defaults to, standing in for the current
// git remote real gh reads. Seeded by the fake alongside the mounted one.
const GH_CLI_REPO = 'integ/repo-cli'

// The fake api.github.com server (integ/server/github) is a kit fake, external
// and shared across both hosts, mirroring the fake Slack server. It used to
// have to be out of process for the python host, whose GitHubResource
// fetched the repo tree with a blocking urlopen from its constructor; that
// fetch is awaited now, so being shared is the only reason left.
async function openGitHub(target: Target): Promise<Open> {
  let base = process.env.GITHUB_URL ?? ''
  while (base.endsWith('/')) base = base.slice(0, -1)
  if (base === '') throw new Error('github target requires GITHUB_URL')
  // The write battery runs once per host against one shared fake, so it
  // starts from the seed rather than from the other host's writes.
  if (target.clis?.includes('gh') === true) {
    const reset = await fetch(`${base}/reset`, { method: 'POST' })
    if (!reset.ok) throw new Error(`github /reset failed: ${String(reset.status)}`)
  }
  const mounts: Record<string, GitHubResource | RAMResource | [GitHubResource, MountMode]> = {}
  for (const m of target.mounts) {
    if (m.resource === 'ram') {
      mounts[m.path] = new RAMResource()
      continue
    }
    const [owner, repo] = String(m.repo).split('/')
    const resource = await GitHubResource.create({
      token: 'ghp-integ',
      owner: owner ?? '',
      repo: repo ?? '',
      baseUrl: base,
    })
    mounts[m.path] = m.mode === 'read' ? [resource, MountMode.READ] : resource
  }
  const ws = new Workspace(mounts, { mode: MountMode.WRITE })
  if (target.clis?.includes('gh') === true) {
    ws.registerCli('gh', GH, {
      token: 'ghp-integ',
      base_url: base,
      repo: GH_CLI_REPO,
      branch: 'main',
    })
  }
  return { ws: ws as unknown as ExecWorkspace, cleanup: () => ws.close() }
}

// In-process for the reason openMem0 is: the fake is a kit fake and this host
// is already a node process, so the target needs no CI setup at all.
async function openDify(target: Target): Promise<Open> {
  // Imported here rather than at the top of the file, because this module is
  // loaded for every target and a kit fake's module reaches its generated
  // Prisma client at import time. See the eslint rule in integ/eslint.config.js.
  const { difyFake } = await import('../../../server/dify/fake.ts')
  const server = await startKitFake(difyFake)
  const mounts: Record<string, DifyResource> = {}
  for (const m of target.mounts) {
    mounts[m.path] = new DifyResource({
      apiKey: 'integ-key',
      baseUrl: server.endpoint,
      datasetId: target.dataset ?? 'kb-7f3a',
    })
  }
  const ws = new Workspace(mounts, { mode: MountMode.WRITE })
  const cleanup = async (): Promise<void> => {
    await ws.close()
    await server.close()
  }
  return { ws: ws as unknown as ExecWorkspace, cleanup }
}

async function openTrello(target: Target): Promise<Open> {
  const endpoint = process.env.TRELLO_URL
  if (!endpoint) throw new Error('trello target requires TRELLO_URL')
  // The server outlives a single run here, so cards and comments the write
  // cases create have to be rolled back to the fixture before they run
  // again -- and before the other host's run, which shares this server.
  const reset = await fetch(`${endpoint}/reset`, { method: 'POST' })
  if (!reset.ok) throw new Error(`trello /reset failed: ${String(reset.status)}`)
  const mounts: Record<string, TrelloResource | RAMResource> = {}
  for (const m of target.mounts) {
    if (m.resource === 'ram') {
      mounts[m.path] = new RAMResource()
      continue
    }
    mounts[m.path] = new TrelloResource({
      apiKey: 'integ-key',
      apiToken: 'integ-token',
      baseUrl: endpoint,
    })
  }
  const ws = new Workspace(mounts, { mode: MountMode.WRITE })
  return { ws: ws as unknown as ExecWorkspace, cleanup: () => ws.close() }
}

async function openDiscord(target: Target): Promise<Open> {
  const endpoint = process.env.DISCORD_URL
  if (!endpoint) throw new Error('discord target requires DISCORD_URL')
  // The server outlives a single run here, so posted messages have to be
  // rolled back to the fixture before the write cases run again.
  const reset = await fetch(`${endpoint}/reset`, { method: 'POST' })
  if (!reset.ok) throw new Error(`discord /reset failed: ${String(reset.status)}`)
  const mounts: Record<string, DiscordResource | RAMResource> = {}
  for (const m of target.mounts) {
    if (m.resource === 'ram') {
      mounts[m.path] = new RAMResource()
      continue
    }
    mounts[m.path] = new DiscordResource({
      token: 'integ-bot-token',
      baseUrl: `${endpoint}/api/v10`,
    })
  }
  const ws = new Workspace(mounts, { mode: MountMode.WRITE })
  if (target.clis?.includes('discord') === true) {
    ws.registerCli('discord', DISCORD, {
      token: 'integ-bot-token',
      base_url: `${endpoint}/api/v10`,
    })
  }
  return { ws: ws as unknown as ExecWorkspace, cleanup: () => ws.close() }
}

async function openLinear(target: Target): Promise<Open> {
  const endpoint = process.env.LINEAR_URL
  if (!endpoint) throw new Error('linear target requires LINEAR_URL')
  // The server outlives a single run here, so mutations from the CLI
  // write cases have to be rolled back to the fixture before the read
  // goldens run again.
  // LINEAR_URL is an ORIGIN, like every other service's variable. The graphql
  // path is this service's, not the variable's, so it is appended at the two
  // call sites that speak graphql and never at /reset.
  const origin = endpoint.replace(/\/$/, '')
  const graphql = `${origin}/graphql`
  const resetUrl = `${origin}/reset`
  const reset = await fetch(resetUrl, { method: 'POST' })
  if (!reset.ok) throw new Error(`linear /reset failed: ${String(reset.status)}`)
  const mounts: Record<string, LinearResource | RAMResource> = {}
  for (const m of target.mounts) {
    if (m.resource === 'ram') {
      mounts[m.path] = new RAMResource()
      continue
    }
    mounts[m.path] = new LinearResource({
      apiKey: 'integ-key',
      baseUrl: graphql,
    })
  }
  const ws = new Workspace(mounts, { mode: MountMode.WRITE })
  if (target.clis?.includes('linear') === true) {
    ws.registerCli('linear', LINEAR, { api_key: 'integ-key', base_url: graphql })
  }
  return { ws: ws as unknown as ExecWorkspace, cleanup: () => ws.close() }
}

// The jaeger stack is a real jaeger all-in-one container, seeded over OTLP by
// integ/server/jaeger_seed.py so trace ids and timestamps are fixed.
async function openJaeger(target: Target): Promise<Open> {
  const host = process.env.JAEGER_URL
  if (!host) throw new Error('jaeger target requires JAEGER_URL')
  const mounts: Record<string, JaegerResource | RAMResource> = {}
  for (const m of target.mounts) {
    if (m.resource === 'ram') {
      mounts[m.path] = new RAMResource()
      continue
    }
    mounts[m.path] = new JaegerResource({ host })
  }
  const ws = new Workspace(mounts, { mode: MountMode.WRITE })
  return { ws: ws as unknown as ExecWorkspace, cleanup: () => ws.close() }
}

// The langfuse stack is a real self-hosted Langfuse (integ/server/
// langfuse_compose.yml), seeded by integ/server/langfuse_seed.py. The project
// keys come from LANGFUSE_INIT_* headless initialization, so they are fixed.
async function openLangfuse(target: Target): Promise<Open> {
  const host = process.env.LANGFUSE_URL
  if (!host) throw new Error('langfuse target requires LANGFUSE_URL')
  const mounts: Record<string, LangfuseResource | RAMResource> = {}
  for (const m of target.mounts) {
    if (m.resource === 'ram') {
      mounts[m.path] = new RAMResource()
      continue
    }
    mounts[m.path] = new LangfuseResource({
      publicKey: process.env.LANGFUSE_PUBLIC_KEY ?? 'pk-lf-mirage-integ',
      secretKey: process.env.LANGFUSE_SECRET_KEY ?? 'sk-lf-mirage-integ',
      host,
    })
  }
  const ws = new Workspace(mounts, { mode: MountMode.WRITE })
  return { ws: ws as unknown as ExecWorkspace, cleanup: () => ws.close() }
}

// Backends reachable with dummy credentials and no server, for the arg-error
// battery: an invalid -maxdepth/-mindepth/-size/-mtime must be rejected while
// flags are parsed, before any network call, so construction is all these
// targets ever need. github, notion and hf_buckets are absent on purpose:
// github needs a live repo at construct, notion an OAuth provider, and
// hf_buckets validates the bucket id.
const ARG_ERROR_RESOURCES: Record<string, () => Resource> = {
  databricks: () =>
    new DatabricksVolumeResource({ catalog: 'c', schema: 's', volume: 'v', rootPath: '/' }),
  discord: () => new DiscordResource({ token: 'x' }),
  email: () =>
    new EmailResource({
      imapHost: 'h',
      imapPort: 993,
      smtpHost: 'h',
      smtpPort: 587,
      username: 'u',
      password: 'p',
      useSsl: true,
      maxMessages: 200,
    }),
  gdocs: () => new GDocsResource({ clientId: 'c', refreshToken: 'r' }),
  gdrive: () => new GDriveResource({ clientId: 'c', refreshToken: 'r' }),
  gmail: () => new GmailResource({ clientId: 'c', refreshToken: 'r' }),
  gsheets: () => new GSheetsResource({ clientId: 'c', refreshToken: 'r' }),
  gslides: () => new GSlidesResource({ clientId: 'c', refreshToken: 'r' }),
  langfuse: () => new LangfuseResource({ publicKey: 'p', secretKey: 's' }),
  linear: () => new LinearResource({ apiKey: 'k' }),
  mem0: () => new Mem0Resource({ apiKey: 'k', userId: 'u' }),
  onedrive: () => new OneDriveResource({ accessToken: 't' }),
  sharepoint: () => new SharePointResource({ accessToken: 't' }),
  slack: () => new SlackResource({ token: 'x' }),
  trello: () => new TrelloResource({ apiKey: 'k', apiToken: 't' }),
}

// The fixture web server curl and wget fetch from. Exported through
// HTTP_ENDPOINT rather than a mount, because the cases name it as a URL in the
// command text (the {http} token) instead of a path. Starting it in-process
// means --facet http needs no CI setup and no python interpreter.
async function openHttp(target: Target): Promise<Open> {
  // Imported here rather than at the top of the file, because this module is
  // loaded for every target and a kit fake's module reaches its generated
  // Prisma client at import time. See the eslint rule in integ/eslint.config.js.
  const { httpFake } = await import('../../../server/http/fake.ts')
  const server = await startKitFake(httpFake)
  process.env.HTTP_ENDPOINT = server.endpoint
  const mounts: Record<string, RAMResource | [RAMResource, MountMode]> = {}
  for (const m of target.mounts) {
    const resource = new RAMResource()
    mounts[m.path] = m.mode === 'read' ? [resource, MountMode.READ] : resource
  }
  const ws = new Workspace(mounts, { mode: MountMode.WRITE })
  const cleanup = async (): Promise<void> => {
    await ws.close()
    await server.close()
    delete process.env.HTTP_ENDPOINT
  }
  return { ws: ws as unknown as ExecWorkspace, cleanup }
}

async function openArgError(target: Target): Promise<Open> {
  const mounts: Record<string, Resource | [Resource, MountMode]> = {}
  for (const m of target.mounts) {
    const resource = ARG_ERROR_RESOURCES[m.backend]()
    mounts[m.path] = m.mode === 'read' ? [resource, MountMode.READ] : resource
  }
  const ws = new Workspace(mounts, { mode: MountMode.WRITE })
  return { ws: ws as unknown as ExecWorkspace, cleanup: () => ws.close() }
}

export const ADAPTERS: Record<string, (target: Target, options?: OpenOptions) => Promise<Open>> = {
  ram: openRam,
  disk: openDisk,
  redis: openRedis,
  opfs: openOpfs,
  s3: openS3,
  databricks_volume: openDatabricksVolume,
  nextcloud: openNextcloud,
  gridfs: openGridfs,
  ssh: openSsh,
  gcal: openGws,
  gdrive: openGws,
  gdocs: openGws,
  gsheets: openGws,
  gslides: openGws,
  gmail: openGws,
  email: openEmail,
  hf: openHf,
  hf_models: openHfHub,
  hf_datasets: openHfHub,
  hf_spaces: openHfHub,
  box: openBox,
  dropbox: openDropbox,
  onedrive: openOneDrive,
  sharepoint: openSharePoint,
  mem0: openMem0,
  postgres: openPostgres,
  mongodb: openMongodb,
  chroma: openChroma,
  qdrant: openQdrant,
  lancedb: openLancedb,
  notion: openNotion,
  github: openGitHub,
  slack: openSlack,
  trello: openTrello,
  discord: openDiscord,
  linear: openLinear,
  langfuse: openLangfuse,
  jaeger: openJaeger,
  dify: openDify,
  arg_error: openArgError,
  http_fixture: openHttp,
}

/**
 * Open a target for a consistency scenario: a workspace under the requested
 * policy plus a shadow workspace the scenario mutates through, out of band
 * from the first one's caches.
 *
 * Returns null when the target's adapter cannot build its mounts twice, which
 * the runner reports as a skip -- a scenario that quietly never ran is worse
 * than one that says it did not.
 */
export async function openConsistency(
  target: Target,
  consistency: ConsistencyPolicy,
): Promise<OpenConsistency | null> {
  const adapter = ADAPTERS[target.mounts[0].resource]
  if (adapter === undefined) return null
  const opened = await adapter(target, { consistency })
  if (opened.shadow === undefined) {
    await opened.cleanup()
    return null
  }
  const shadow = opened.shadow()
  const mutate = async (path: string, content: Uint8Array): Promise<void> => {
    const result = await shadow.execute(`tee ${path} > /dev/null`, { stdin: content })
    if (result.exitCode !== 0) {
      throw new Error(new TextDecoder().decode(result.stderr))
    }
  }
  return { ws: opened.ws, mutate, cleanup: opened.cleanup }
}
