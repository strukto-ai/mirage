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
  GCSResource,
  GitHubResource,
  GitHubCIResource,
  GridFSResource,
  GSheetsResource,
  GSlidesResource,
  DISCORD,
  GWS,
  HIMALAYA,
  GIT,
  LINEAR,
  NTN,
  SLACK,
  HfBucketsResource,
  JaegerResource,
  LanceDBResource,
  LangfuseResource,
  LinearResource,
  MinIOResource,
  Mem0Resource,
  MongoDBResource,
  NotionResource,
  ConsistencyPolicy,
  MountMode,
  NextcloudResource,
  OCIResource,
  OneDriveResource,
  PostgresResource,
  QdrantResource,
  QingStorResource,
  R2Resource,
  RAMResource,
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
} from '@struktoai/mirage-node'
import * as lancedb from '@lancedb/lancedb'
import { QdrantClient } from '@qdrant/js-client-rest'
import { ChromaClient } from 'chromadb'
import { ImapFlow } from 'imapflow'
import { Double, MongoClient } from 'mongodb'
import pg from 'pg'
import { installFakeNavigator, makeMockRoot } from '../../../typescript/packages/browser/src/test-utils.ts'
import { startFakeDropbox, type FakeDropbox } from '../../server/dropbox.ts'
import { integRoot, walkFiles } from './harness.ts'
import type { ExecWorkspace, Mount, Target } from './harness.ts'
import { startPythonServer } from './server_process.ts'

export interface Open {
  ws: ExecWorkspace
  cleanup: () => Promise<void>
}

export interface OpenConsistency extends Open {
  mutate: (path: string, content: Uint8Array) => Promise<void>
}

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379/0'
const MONGODB_URI = process.env.MONGODB_URI ?? 'mongodb://localhost:27017'
const S3_ENDPOINT = process.env.S3_ENDPOINT
const S3_REGION = process.env.S3_REGION ?? 'us-east-1'
const S3_ACCESS = process.env.AWS_ACCESS_KEY_ID ?? 'testing'
const S3_SECRET = process.env.AWS_SECRET_ACCESS_KEY ?? 'testing'
const DATABRICKS_ENDPOINT = process.env.DATABRICKS_ENDPOINT
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
function installLocalClis(ws: { registerCli: (name: string, spec: unknown) => void }, target: Target): void {
  if (target.clis?.includes('git') === true) ws.registerCli('git', GIT)
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
    mounts[m.path] = m.mode === 'read' ? [resource, MountMode.READ] : resource
  }
  const ws = new Workspace(mounts, {
    mode: MountMode.WRITE,
    ...(target.agentId !== undefined ? { agentId: target.agentId } : {}),
  })
  installLocalClis(ws, target)
  return { ws: ws as unknown as ExecWorkspace, cleanup: () => ws.close() }
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
  const ws = new Workspace(mounts, { mode: MountMode.WRITE })
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

async function openGridfs(target: Target): Promise<Open> {
  const id = runId()
  const uri = MONGODB_URI
  const database = `mirage_integ_${id}`
  const mounts: Record<string, GridFSResource> = {}
  for (const m of target.mounts) {
    mounts[m.path] = new GridFSResource({
      uri,
      database,
      bucket: String(m.bucket),
      keyPrefix: m.prefix,
    })
  }
  const ws = new Workspace(mounts, { mode: MountMode.WRITE })
  const cleanup = async (): Promise<void> => {
    await ws.close()
    const { MongoClient } = await import('mongodb')
    const client = new MongoClient(uri)
    try {
      await client.db(database).dropDatabase()
    } finally {
      await client.close()
    }
  }
  return { ws: ws as unknown as ExecWorkspace, cleanup }
}

async function openDatabricksVolume(target: Target): Promise<Open> {
  if (DATABRICKS_ENDPOINT === undefined || DATABRICKS_ENDPOINT === '') {
    throw new Error('databricks target requires DATABRICKS_ENDPOINT')
  }
  const endpoint = DATABRICKS_ENDPOINT
  const id = runId()
  const token = 'integ-token'
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
  return { ws: ws as unknown as ExecWorkspace, cleanup: () => ws.close() }
}

function objectStorageResource(name: string, bucket: string, keyPrefix: string | undefined): S3Resource {
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

async function openS3(target: Target): Promise<Open> {
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
  const mounts: Record<string, S3Resource> = {}
  for (const m of target.mounts) {
    const bucket = await bucketFor(m)
    mounts[m.path] = objectStorageResource(m.resource, bucket, m.prefix)
  }
  const ws = new Workspace(mounts, { mode: MountMode.WRITE })
  const cleanup = async (): Promise<void> => {
    await ws.close()
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
  return { ws: ws as unknown as ExecWorkspace, cleanup }
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
const EMAIL_API_PORT = Number(process.env.EMAIL_API_PORT ?? '8080')
const EMAIL_USERNAME = 'integ@example.com'
const EMAIL_PASSWORD = 'secret'
// Doubles as the workspace id on the fake notion server.
const NOTION_TOKEN = 'integ-test'

// The GreenMail server is external and shared; its REST API purges every
// mailbox between runs. Seeding appends RFC822 payloads over IMAP so folder
// UIDs are the append order (1, 2, ...) and date dirs come from the
// manifest Date headers.
async function openEmail(target: Target): Promise<Open> {
  const host = process.env.EMAIL_HOST
  if (host === undefined || host === '') throw new Error('email target requires EMAIL_HOST')
  const reset = await fetch(`http://${host}:${String(EMAIL_API_PORT)}/api/service/reset`, {
    method: 'POST',
  })
  if (!reset.ok) throw new Error(`greenmail reset failed: ${String(reset.status)}`)
  if (target.mail !== undefined) {
    const manifest = join(integRoot(), 'fixtures', `${target.mail}.json`)
    const entries = JSON.parse(readFileSync(manifest, 'utf8')) as MailEntry[]
    const imap = new ImapFlow({
      host,
      port: EMAIL_IMAP_PORT,
      secure: false,
      auth: { user: EMAIL_USERNAME, pass: EMAIL_PASSWORD },
      logger: false,
    })
    await imap.connect()
    const known = new Set(['INBOX'])
    for (const entry of entries) {
      const folder = entry.folder ?? 'INBOX'
      if (!known.has(folder)) {
        await imap.mailboxCreate(folder)
        known.add(folder)
      }
      await imap.append(
        folder,
        buildRfc822(entry),
        entry.seen === true ? ['\\Seen'] : [],
        new Date(entry.date),
      )
    }
    await imap.logout()
  }
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
      password: EMAIL_PASSWORD,
      useSsl: false,
      maxMessages: 200,
    })
  }
  const ws = new Workspace(mounts, { mode: MountMode.WRITE })
  if (target.clis?.includes('himalaya') === true) {
    // Every registerCli in this file installs the same snake_case block
    // the Python runner does, so the cli facet proves one YAML config
    // serves both hosts rather than only that each host has some config
    // it accepts. The registry camelizes onto declared fields.
    ws.registerCli('himalaya', HIMALAYA, {
      imap_host: host,
      imap_port: EMAIL_IMAP_PORT,
      smtp_host: host,
      smtp_port: EMAIL_SMTP_PORT,
      username: EMAIL_USERNAME,
      password: EMAIL_PASSWORD,
      use_ssl: false,
    })
  }
  return { ws: ws as unknown as ExecWorkspace, cleanup: () => ws.close() }
}

async function openHf(target: Target): Promise<Open> {
  const endpoint = process.env.HF_ENDPOINT
  if (!endpoint) throw new Error('hf target requires HF_ENDPOINT')
  const id = runId()
  const mounts: Record<string, HfBucketsResource> = {}
  for (const m of target.mounts) {
    // Buckets auto-create on first touch in the fake hub, so a per-run
    // bucket name is enough isolation.
    mounts[m.path] = new HfBucketsResource({
      bucket: `integ/${id}-${String(m.bucket)}`,
      token: 'integ-token',
      endpoint,
      keyPrefix: m.prefix,
    })
  }
  const ws = new Workspace(mounts, { mode: MountMode.WRITE })
  return { ws: ws as unknown as ExecWorkspace, cleanup: () => ws.close() }
}

const BOX_AUTH = { Authorization: 'Bearer integ-box-token' }

async function boxCreateWebLink(
  endpoint: string,
  parentId: string,
  name: string,
  url: string,
): Promise<void> {
  const r = await fetch(`${endpoint}/2.0/web_links`, {
    method: 'POST',
    headers: { ...BOX_AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, url, parent: { id: parentId } }),
  })
  if (r.status !== 201) throw new Error(`box web_link seed failed: ${String(r.status)}`)
}

async function boxCreateFolder(endpoint: string, parentId: string, name: string): Promise<string> {
  const r = await fetch(`${endpoint}/2.0/folders`, {
    method: 'POST',
    headers: { ...BOX_AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, parent: { id: parentId } }),
  })
  if (r.status === 201) return ((await r.json()) as { id: string }).id
  if (r.status === 409) {
    const list = await fetch(`${endpoint}/2.0/folders/${parentId}/items?limit=1000`, {
      headers: BOX_AUTH,
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
  folderId: string,
  name: string,
  content: Uint8Array,
): Promise<void> {
  const form = new FormData()
  form.set('attributes', JSON.stringify({ name, parent: { id: folderId } }))
  form.set('file', new Blob([content]), name)
  const r = await fetch(`${endpoint}/2.0/files/content`, {
    method: 'POST',
    headers: BOX_AUTH,
    body: form,
  })
  if (r.status !== 201) throw new Error(`box upload ${name} -> ${String(r.status)}`)
}

async function openBox(target: Target): Promise<Open> {
  const endpoint = process.env.BOX_ENDPOINT
  if (!endpoint) throw new Error('box target requires BOX_ENDPOINT')
  const id = runId()
  const root = integRoot()
  const mounts: Record<string, BoxResource> = {}
  for (const m of target.mounts) {
    // Box is read-only through the workspace, so the harness tee-seeding
    // can't run; the fixture is uploaded over the Box API instead. The
    // shared fake server outlives a run, so a per-run folder name isolates
    // runs, and the folder id becomes the mount root (mirrors how a real
    // Box app scopes to a folder).
    const folderId = await boxCreateFolder(endpoint, '0', `integ-${id}-${String(m.folder)}`)
    if (m.seed !== undefined) {
      const base = join(root, 'fixtures', m.seed)
      for (const file of walkFiles(base)) {
        const rel = relative(base, file).split(sep).join('/')
        const parts = rel.split('/')
        let parentId = folderId
        for (const dir of parts.slice(0, -1)) {
          parentId = await boxCreateFolder(endpoint, parentId, dir)
        }
        await boxUpload(
          endpoint,
          parentId,
          parts[parts.length - 1] ?? '',
          new Uint8Array(readFileSync(file)),
        )
      }
    }
    if (m.seed === 'files/v1') {
      // A weblink beside the fixture: sizeless and content-free, so
      // listings must hide it and a direct stat must ENOENT.
      await boxCreateWebLink(endpoint, folderId, 'homepage', 'https://example.com/')
    }
    mounts[m.path] = new BoxResource({
      accessToken: 'integ-box-token',
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

async function openDropbox(target: Target): Promise<Open> {
  // Mounts sharing a `bucket` share one fake account (the -root target
  // mounts three rootPath subfolders of a single account, mirroring
  // s3-prefix's shared bucket); distinct buckets get isolated accounts.
  const accounts = new Map<string, FakeDropbox>()
  const mounts: Record<string, DropboxResource> = {}
  for (const m of target.mounts) {
    const account = String(m.bucket ?? m.path)
    let fake = accounts.get(account)
    if (fake === undefined) {
      fake = await startFakeDropbox()
      accounts.set(account, fake)
    }
    mounts[m.path] = new DropboxResource({
      clientId: 'integ-client',
      clientSecret: 'integ-secret',
      refreshToken: 'integ-refresh',
      // The fake supports full-text search_v2, so exercise grep/rg
      // narrowing in the battery.
      contentSearch: true,
      endpoint: fake.endpoint,
      ...(m.root !== undefined ? { rootPath: m.root } : {}),
    })
  }
  const ws = new Workspace(mounts, { mode: MountMode.WRITE })
  const cleanup = async (): Promise<void> => {
    await ws.close()
    for (const fake of accounts.values()) fake.close()
  }
  return { ws: ws as unknown as ExecWorkspace, cleanup }
}

async function openOneDrive(target: Target): Promise<Open> {
  const server = await startPythonServer('onedrive_server.py', {
    MIRAGE_GRAPH_DRIVES: 'data,xm2,res,shared',
  })
  const mounts: Record<string, OneDriveResource> = {}
  for (const mount of target.mounts) {
    mounts[mount.path] = new OneDriveResource({
      accessToken: 'integ-token',
      graphBaseUrl: server.endpoint,
      ...(mount.prefix !== undefined ? { keyPrefix: mount.prefix } : {}),
    })
  }
  const ws = new Workspace(mounts, { mode: MountMode.WRITE })
  const cleanup = async (): Promise<void> => {
    await ws.close()
    await server.close()
  }
  return { ws: ws as unknown as ExecWorkspace, cleanup }
}

async function openSharePoint(target: Target): Promise<Open> {
  const server = await startPythonServer('onedrive_server.py', {
    MIRAGE_GRAPH_DRIVES: 'data,xm2,res,shared',
  })
  const mounts: Record<string, SharePointResource> = {}
  for (const mount of target.mounts) {
    mounts[mount.path] = new SharePointResource({
      accessToken: 'integ-token',
      graphBaseUrl: server.endpoint,
      site: 'Main',
      drive: mount.drive,
      ...(mount.prefix !== undefined ? { keyPrefix: mount.prefix } : {}),
    })
  }
  const ws = new Workspace(mounts, { mode: MountMode.WRITE })
  const cleanup = async (): Promise<void> => {
    await ws.close()
    await server.close()
  }
  return { ws: ws as unknown as ExecWorkspace, cleanup }
}

async function openGraphConsistency(
  target: Target,
  consistency: ConsistencyPolicy,
): Promise<OpenConsistency> {
  const server = await startPythonServer('onedrive_server.py', {
    MIRAGE_GRAPH_DRIVES: 'data,xm2,res,shared',
  })
  const readMounts: Record<string, OneDriveResource | SharePointResource> = {}
  const shadowMounts: Record<string, OneDriveResource | SharePointResource> = {}
  for (const mount of target.mounts) {
    if (mount.resource === 'onedrive') {
      const config = {
        accessToken: 'integ-token',
        graphBaseUrl: server.endpoint,
        ...(mount.prefix !== undefined ? { keyPrefix: mount.prefix } : {}),
      }
      readMounts[mount.path] = new OneDriveResource(config)
      shadowMounts[mount.path] = new OneDriveResource(config)
    } else {
      const config = {
        accessToken: 'integ-token',
        graphBaseUrl: server.endpoint,
        site: 'Main',
        drive: mount.drive,
        ...(mount.prefix !== undefined ? { keyPrefix: mount.prefix } : {}),
      }
      readMounts[mount.path] = new SharePointResource(config)
      shadowMounts[mount.path] = new SharePointResource(config)
    }
  }
  const ws = new Workspace(readMounts, { mode: MountMode.WRITE, consistency })
  const shadow = new Workspace(shadowMounts, { mode: MountMode.WRITE })
  const mutate = async (path: string, content: Uint8Array): Promise<void> => {
    const result = await shadow.execute(`tee ${path} > /dev/null`, { stdin: content })
    if (result.exitCode !== 0) {
      throw new Error(new TextDecoder().decode(result.stderr))
    }
  }
  const cleanup = async (): Promise<void> => {
    await ws.close()
    await shadow.close()
    await server.close()
  }
  return { ws: ws as unknown as ExecWorkspace, mutate, cleanup }
}

async function openNotion(target: Target): Promise<Open> {
  let base = process.env.NOTION_URL ?? ''
  while (base.endsWith('/')) base = base.slice(0, -1)
  if (base === '') throw new Error('notion target requires NOTION_URL')
  const reset = await fetch(`${base}/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspace: NOTION_TOKEN }),
  })
  if (!reset.ok) throw new Error(`notion /reset failed: ${String(reset.status)}`)
  const mounts: Record<string, NotionResource | RAMResource | [NotionResource, MountMode]> = {}
  for (const mount of target.mounts) {
    if (mount.resource === 'ram') {
      mounts[mount.path] = new RAMResource()
      continue
    }
    const resource = new NotionResource({
      apiKey: NOTION_TOKEN,
      baseUrl: `${base}/v1`,
    })
    mounts[mount.path] = mount.mode === 'read' ? [resource, MountMode.READ] : resource
  }
  const ws = new Workspace(mounts, { mode: MountMode.WRITE })
  if (target.clis?.includes('ntn') === true) {
    ws.registerCli('ntn', NTN, {
      api_key: NOTION_TOKEN,
      base_url: `${base}/v1`,
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

async function openLancedb(target: Target): Promise<Open> {
  const uri = mkdtempSync(join(tmpdir(), 'mirage-integ-lancedb-'))
  const db = await lancedb.connect(uri)
  await db.createTable('animals', LANCEDB_ROWS as Record<string, unknown>[])
  const mounts: Record<string, LanceDBResource | [LanceDBResource, MountMode]> = {}
  for (const mount of target.mounts) {
    const resource = new LanceDBResource({
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

async function openQdrant(target: Target): Promise<Open> {
  const host = process.env.QDRANT_HOST ?? 'localhost'
  const port = Number.parseInt(process.env.QDRANT_PORT ?? '6333', 10)
  const collection = `mirage-integ-${runId()}`
  const client = new QdrantClient({ host, port })
  await client.createCollection(collection, {
    vectors: { size: QDRANT_EMBED_DIM, distance: 'Cosine' },
  })
  await client.upsert(collection, {
    points: QDRANT_ROWS.map(([id, label, kind, name]) => ({
      id,
      vector: Array<number>(QDRANT_EMBED_DIM).fill(0.1),
      payload: { label, kind, name, image_bytes: btoa(`PNG-${String(id)}`) },
    })),
  })
  for (const field of ['label', 'kind']) {
    await client.createPayloadIndex(collection, { field_name: field, field_schema: 'keyword' })
  }
  await new Promise((r) => setTimeout(r, 2000))
  const mounts: Record<string, QdrantResource | [QdrantResource, MountMode]> = {}
  for (const mount of target.mounts) {
    const resource = new QdrantResource({
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
  const collection = await client.createCollection({ name: collectionName, embeddingFunction: null })
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

async function openMem0(target: Target): Promise<Open> {
  const server = await startPythonServer('mem0_server.py')
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

async function openSsh(target: Target): Promise<Open> {
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
  const mounts: Record<string, SSHResource> = {}
  for (const m of target.mounts) {
    mounts[m.path] = new SSHResource({
      host,
      port,
      username: 'integ',
      root: `/${base}/${String(m.root)}`,
    })
  }
  const ws = new Workspace(mounts, { mode: MountMode.WRITE })
  const cleanup = async (): Promise<void> => {
    await ws.close()
    await adminExec(admin, `rm -rf /admin/${base}`)
    await admin.close()
  }
  return { ws: ws as unknown as ExecWorkspace, cleanup }
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

interface MailEntry {
  from: string
  to: string
  cc?: string[]
  subject: string
  date: string
  body: string
  labels?: string[]
  folder?: string
  seen?: boolean
  attachments?: { filename: string; content: string }[]
}

function mimeTextPart(content: string, filename?: string): string {
  const lines = [
    'Content-Type: text/plain; charset="utf-8"',
    'MIME-Version: 1.0',
    'Content-Transfer-Encoding: base64',
  ]
  if (filename !== undefined) {
    lines.push(`Content-Disposition: attachment; filename="${filename}"`)
  }
  return `${lines.join('\r\n')}\r\n\r\n${Buffer.from(content, 'utf-8').toString('base64')}`
}

// Builds the same constrained RFC822 shape python's email.mime emits: one
// base64 text/plain body plus base64 text attachments under multipart/mixed.
function buildRfc822(entry: MailEntry): string {
  const headers = [`From: ${entry.from}`, `To: ${entry.to}`]
  if (entry.cc !== undefined && entry.cc.length > 0) headers.push(`Cc: ${entry.cc.join(', ')}`)
  headers.push(`Subject: ${entry.subject}`, `Date: ${entry.date}`)
  const attachments = entry.attachments ?? []
  if (attachments.length === 0) {
    return `${headers.join('\r\n')}\r\n${mimeTextPart(entry.body)}`
  }
  const boundary = 'integ-mime-boundary'
  const parts = [
    mimeTextPart(entry.body),
    ...attachments.map((att) => mimeTextPart(att.content, att.filename)),
  ]
  return [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    'MIME-Version: 1.0',
    '',
    ...parts.map((part) => `--${boundary}\r\n${part}`),
    `--${boundary}--`,
  ].join('\r\n')
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

function gwsNativeResource(
  resource: string,
  base: string,
): GDocsResource | GSheetsResource | GSlidesResource | GmailResource {
  // apiBase points the backend at the fake server through the same
  // config field a real embedder uses; nothing is monkey-patched.
  const config = { clientId: 'integ', clientSecret: 'integ', refreshToken: 'integ', apiBase: base }
  if (resource === 'gdocs') return new GDocsResource(config)
  if (resource === 'gsheets') return new GSheetsResource(config)
  if (resource === 'gmail') return new GmailResource(config)
  return new GSlidesResource(config)
}

async function openGws(target: Target): Promise<Open> {
  let base = process.env.GWS_URL ?? ''
  while (base.endsWith('/')) base = base.slice(0, -1)
  if (base === '') throw new Error('gdrive target requires GWS_URL')
  // Native mounts (gdocs/gsheets/gslides) render the modified date into
  // filenames, so those targets pin the server clock.
  await gwsJson(`${base}/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(target.epoch !== undefined ? { epoch: target.epoch } : {}),
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
  if (target.apps !== undefined) {
    const manifest = join(integRoot(), 'fixtures', `${target.apps}.json`)
    await seedGwsApps(base, JSON.parse(readFileSync(manifest, 'utf8')) as GwsAppEntry[])
  }
  if (target.mail !== undefined) {
    const manifest = join(integRoot(), 'fixtures', `${target.mail}.json`)
    await seedGwsMail(base, JSON.parse(readFileSync(manifest, 'utf8')) as MailEntry[])
  }
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
  const reset = await fetch(`${base}/reset`, { method: 'POST' })
  if (!reset.ok) throw new Error(`slack /reset failed: ${String(reset.status)}`)
  const mounts: Record<string, SlackResource | RAMResource> = {}
  for (const m of target.mounts) {
    if (m.resource === 'ram') {
      mounts[m.path] = new RAMResource()
      continue
    }
    mounts[m.path] = new SlackResource({
      token: 'xoxb-integ',
      searchToken: 'xoxp-integ-search',
      baseUrl: `${base}/api`,
    })
  }
  const ws = new Workspace(mounts, { mode: MountMode.WRITE })
  if (target.clis?.includes('slack') === true) {
    ws.registerCli('slack', SLACK, {
      token: 'xoxb-integ',
      search_token: 'xoxp-integ-search',
      base_url: `${base}/api`,
    })
  }
  const cleanup = async (): Promise<void> => {
    await ws.close()
  }
  return { ws: ws as unknown as ExecWorkspace, cleanup }
}

// The fake api.github.com server (integ/server/github_server.py) is external
// and shared across both hosts, mirroring the fake Slack server. It used to
// have to be out of process for the python host, whose GitHubResource
// fetched the repo tree with a blocking urlopen from its constructor; that
// fetch is awaited now, so being shared is the only reason left.
async function openGitHub(target: Target): Promise<Open> {
  let base = process.env.GITHUB_URL ?? ''
  while (base.endsWith('/')) base = base.slice(0, -1)
  if (base === '') throw new Error('github target requires GITHUB_URL')
  const mounts: Record<string, GitHubResource | [GitHubResource, MountMode]> = {}
  for (const m of target.mounts) {
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
  return { ws: ws as unknown as ExecWorkspace, cleanup: () => ws.close() }
}

// Reuses the external github_server.py process on GITHUB_URL, which also
// serves the fixed Actions dataset (workflows/runs/jobs/artifacts).
async function openGitHubCI(target: Target): Promise<Open> {
  let base = process.env.GITHUB_URL ?? ''
  while (base.endsWith('/')) base = base.slice(0, -1)
  if (base === '') throw new Error('github_ci target requires GITHUB_URL')
  const mounts: Record<string, GitHubCIResource | [GitHubCIResource, MountMode]> = {}
  for (const m of target.mounts) {
    const [owner, repo] = String(m.repo).split('/')
    const resource = new GitHubCIResource({
      token: 'ghp-integ',
      owner: owner ?? '',
      repo: repo ?? '',
      baseUrl: base,
    })
    mounts[m.path] = m.mode === 'read' ? [resource, MountMode.READ] : resource
  }
  const ws = new Workspace(mounts, { mode: MountMode.WRITE })
  return { ws: ws as unknown as ExecWorkspace, cleanup: () => ws.close() }
}

async function openDify(target: Target): Promise<Open> {
  const endpoint = process.env.DIFY_ENDPOINT
  if (!endpoint) throw new Error('dify target requires DIFY_ENDPOINT')
  const mounts: Record<string, DifyResource> = {}
  for (const m of target.mounts) {
    mounts[m.path] = new DifyResource({
      apiKey: 'integ-key',
      baseUrl: endpoint,
      datasetId: target.dataset ?? 'kb-7f3a',
    })
  }
  const ws = new Workspace(mounts, { mode: MountMode.WRITE })
  return { ws: ws as unknown as ExecWorkspace, cleanup: () => ws.close() }
}

async function openTrello(target: Target): Promise<Open> {
  const endpoint = process.env.TRELLO_ENDPOINT
  if (!endpoint) throw new Error('trello target requires TRELLO_ENDPOINT')
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
  const endpoint = process.env.DISCORD_ENDPOINT
  if (!endpoint) throw new Error('discord target requires DISCORD_ENDPOINT')
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
  const endpoint = process.env.LINEAR_ENDPOINT
  if (!endpoint) throw new Error('linear target requires LINEAR_ENDPOINT')
  // The server outlives a single run here, so mutations from the CLI
  // write cases have to be rolled back to the fixture before the read
  // goldens run again.
  const resetUrl = `${endpoint.replace(/\/graphql$/, '')}/reset`
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
      baseUrl: endpoint,
    })
  }
  const ws = new Workspace(mounts, { mode: MountMode.WRITE })
  if (target.clis?.includes('linear') === true) {
    ws.registerCli('linear', LINEAR, { api_key: 'integ-key', base_url: endpoint })
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
  github_ci: () => new GitHubCIResource({ token: 't', owner: 'o', repo: 'r' }),
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
// command text (the {http} token) instead of a path. Owning the process here
// means --facet http needs no CI setup.
async function openHttp(target: Target): Promise<Open> {
  const server = await startPythonServer('http_server.py')
  process.env.HTTP_ENDPOINT = server.endpoint.replace(/^HTTP_ENDPOINT=/, '')
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

export const ADAPTERS: Record<string, (target: Target) => Promise<Open>> = {
  ram: openRam,
  disk: openDisk,
  redis: openRedis,
  opfs: openOpfs,
  s3: openS3,
  databricks_volume: openDatabricksVolume,
  nextcloud: openNextcloud,
  gridfs: openGridfs,
  ssh: openSsh,
  gdrive: openGws,
  gdocs: openGws,
  gsheets: openGws,
  gslides: openGws,
  gmail: openGws,
  email: openEmail,
  hf: openHf,
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
  github_ci: openGitHubCI,
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

export const CONSISTENCY_ADAPTERS: Record<
  string,
  (target: Target, consistency: ConsistencyPolicy) => Promise<OpenConsistency>
> = {
  onedrive: openGraphConsistency,
  sharepoint: openGraphConsistency,
}
