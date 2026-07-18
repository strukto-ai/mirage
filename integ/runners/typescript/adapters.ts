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

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3'
import { OPFSResource, Workspace as BrowserWorkspace } from '@struktoai/mirage-browser'
import {
  DiskResource,
  HfBucketsResource,
  MountMode,
  RAMResource,
  RedisResource,
  S3Resource,
  SSHResource,
  Workspace,
} from '@struktoai/mirage-node'
import { installFakeNavigator, makeMockRoot } from '../../../typescript/packages/browser/src/test-utils.ts'
import type { ExecWorkspace, Mount, Target } from './harness.ts'

export interface Open {
  ws: ExecWorkspace
  cleanup: () => Promise<void>
}

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379/0'
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

export const ADAPTERS: Record<string, (target: Target) => Promise<Open>> = {
  ram: openRam,
  disk: openDisk,
  redis: openRedis,
  opfs: openOpfs,
  s3: openS3,
  ssh: openSsh,
  hf: openHf,
}
