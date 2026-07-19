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
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3'
import { OPFSResource, Workspace as BrowserWorkspace } from '@struktoai/mirage-browser'
import {
  BoxResource,
  DiskResource,
  DropboxResource,
  GDocsResource,
  GDriveResource,
  GridFSResource,
  GSheetsResource,
  GSlidesResource,
  HfBucketsResource,
  MountMode,
  RAMResource,
  RedisResource,
  S3Resource,
  SSHResource,
  Workspace,
} from '@struktoai/mirage-node'
import { installFakeNavigator, makeMockRoot } from '../../../typescript/packages/browser/src/test-utils.ts'
import { startFakeDropbox, type FakeDropbox } from '../../server/dropbox.ts'
import { integRoot, walkFiles } from './harness.ts'
import type { ExecWorkspace, Mount, Target } from './harness.ts'

export interface Open {
  ws: ExecWorkspace
  cleanup: () => Promise<void>
}

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379/0'
const MONGODB_URI = process.env.MONGODB_URI ?? 'mongodb://localhost:27017'
const S3_ENDPOINT = process.env.S3_ENDPOINT
const S3_REGION = process.env.S3_REGION ?? 'us-east-1'
const S3_ACCESS = process.env.AWS_ACCESS_KEY_ID ?? 'testing'
const S3_SECRET = process.env.AWS_SECRET_ACCESS_KEY ?? 'testing'

function runId(): string {
  return `${String(process.pid)}-${String(Date.now())}`
}

async function openRam(target: Target): Promise<Open> {
  const mounts: Record<string, RAMResource> = {}
  for (const m of target.mounts) mounts[m.path] = new RAMResource()
  const ws = new Workspace(mounts, { mode: MountMode.WRITE })
  return { ws: ws as unknown as ExecWorkspace, cleanup: () => ws.close() }
}

async function openDisk(target: Target): Promise<Open> {
  const roots: string[] = []
  const mounts: Record<string, DiskResource> = {}
  for (const m of target.mounts) {
    const root = mkdtempSync(join(tmpdir(), 'mirage-integ-disk-'))
    roots.push(root)
    mounts[m.path] = new DiskResource({ root })
  }
  const ws = new Workspace(mounts, { mode: MountMode.WRITE })
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
    mounts[m.path] = new S3Resource({
      bucket,
      region: S3_REGION,
      endpoint: S3_ENDPOINT,
      accessKeyId: S3_ACCESS,
      secretAccessKey: S3_SECRET,
      forcePathStyle: true,
      keyPrefix: m.prefix,
    })
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
    mounts[m.path] = new BoxResource({
      accessToken: 'integ-box-token',
      endpoint,
      rootFolderId: folderId,
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
  const admin = new Workspace(
    { '/admin': new SSHResource({ host, port, username: 'integ' }) },
    { mode: MountMode.WRITE },
  )
  const paths = target.mounts.map((m) => `/admin/${base}/${String(m.root)}`).join(' ')
  await adminExec(admin, `mkdir -p ${paths}`)
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

function gwsNativeResource(base: string, resource: string): GDocsResource | GSheetsResource | GSlidesResource {
  const config = { clientId: 'integ', clientSecret: 'integ', refreshToken: 'integ', apiBase: base }
  if (resource === 'gdocs') return new GDocsResource(config)
  if (resource === 'gsheets') return new GSheetsResource(config)
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
  const mounts: Record<string, GDriveResource | GDocsResource | GSheetsResource | GSlidesResource> = {}
  const driveIds: Record<string, string> = {}
  for (const m of target.mounts) {
    if (m.resource !== 'gdrive') {
      mounts[m.path] = gwsNativeResource(base, m.resource)
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
  }
  if (target.apps !== undefined) {
    const manifest = join(integRoot(), 'fixtures', `${target.apps}.json`)
    await seedGwsApps(base, JSON.parse(readFileSync(manifest, 'utf8')) as GwsAppEntry[])
  }
  const ws = new Workspace(mounts, { mode: MountMode.WRITE })
  const cleanup = async (): Promise<void> => {
    await ws.close()
  }
  return { ws: ws as unknown as ExecWorkspace, cleanup }
}

export const ADAPTERS: Record<string, (target: Target) => Promise<Open>> = {
  ram: openRam,
  disk: openDisk,
  redis: openRedis,
  opfs: openOpfs,
  s3: openS3,
  gridfs: openGridfs,
  ssh: openSsh,
  gdrive: openGws,
  gdocs: openGws,
  gsheets: openGws,
  gslides: openGws,
  hf: openHf,
  box: openBox,
  dropbox: openDropbox,
}
