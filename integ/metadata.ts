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

import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FileStat } from '@struktoai/mirage-node'
import {
  DiskResource,
  MountMode,
  RAMResource,
  RedisResource,
  S3Resource,
  Workspace,
} from '@struktoai/mirage-node'
import { metaStatLine, runMetaCases, runMetaOverlayCases } from './cases.ts'

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379/0'

function s3ResourceFromEnv(keyPrefix: string): S3Resource {
  const bucket = process.env.S3_BUCKET
  if (bucket === undefined || bucket === '') {
    throw new Error('S3_BUCKET env required (point at MinIO or AWS bucket)')
  }
  const endpoint = process.env.S3_ENDPOINT
  const region = process.env.S3_REGION ?? 'us-east-1'
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY
  return new S3Resource({
    bucket,
    region,
    keyPrefix,
    ...(endpoint !== undefined && endpoint !== '' ? { endpoint, forcePathStyle: true } : {}),
    ...(accessKeyId !== undefined && accessKeyId !== '' ? { accessKeyId } : {}),
    ...(secretAccessKey !== undefined && secretAccessKey !== '' ? { secretAccessKey } : {}),
  })
}

async function runOverlaySnapshotRoundtrip(ws: Workspace, fresh: S3Resource): Promise<void> {
  // Overlay attrs live in namespace NODES, so they must survive a
  // snapshot even though the s3 resource is rebuilt fresh at load
  // (s3 snapshots redact creds and require a resource override).
  await ws.execute('echo alpha > /data/f.txt')
  await ws.execute(
    'chmod 601 /data/f.txt && chown 500:dev /data/f.txt && touch -t 202601021530 /data/f.txt',
  )
  const dir = mkdtempSync(join(tmpdir(), 'mirage-meta-osnap-'))
  const snap = join(dir, 'ws.tar')
  await ws.snapshot(snap)
  const restored = await Workspace.load(snap, {}, { '/data': fresh })
  const st = (await restored.dispatch('stat', '/data/f.txt')) as FileStat
  console.log('=== overlay_snapshot_roundtrip ===')
  console.log(metaStatLine(st, ['mode', 'uid', 'gid', 'mtime']))
  await restored.execute('rm /data/f.txt')
  await restored.close()
  rmSync(dir, { recursive: true, force: true })
}

async function runSnapshotRoundtrip(): Promise<void> {
  const ws = new Workspace({ '/data': new RAMResource() }, { mode: MountMode.WRITE })
  await ws.execute('echo alpha > /data/f.txt')
  await ws.execute(
    'chmod 601 /data/f.txt && chown 500:dev /data/f.txt && touch -t 202601021530 /data/f.txt',
  )
  const dir = mkdtempSync(join(tmpdir(), 'mirage-meta-snap-'))
  const snap = join(dir, 'ws.tar')
  await ws.snapshot(snap)
  const restored = await Workspace.load(snap)
  const result = await restored.execute('ls -l /data')
  console.log('=== snapshot_meta_roundtrip ===')
  console.log(new TextDecoder().decode(result.stdout).trimEnd())
  await ws.close()
  await restored.close()
  rmSync(dir, { recursive: true, force: true })
}

async function main(): Promise<void> {
  console.log('##### ram #####')
  const ramWs = new Workspace({ '/data': new RAMResource() }, { mode: MountMode.WRITE })
  await runMetaCases(ramWs)
  await ramWs.close()

  console.log('##### disk #####')
  const root = mkdtempSync(join(tmpdir(), 'mirage-integ-meta-disk-'))
  const diskWs = new Workspace({ '/data': new DiskResource({ root }) }, { mode: MountMode.WRITE })
  try {
    await runMetaCases(diskWs)
  } finally {
    await diskWs.close()
    rmSync(root, { recursive: true, force: true })
  }

  console.log('##### redis #####')
  const prefix = `mirage-integ-meta-${randomUUID().slice(0, 8)}/`
  const redisWs = new Workspace(
    { '/data': new RedisResource({ url: REDIS_URL, keyPrefix: prefix }) },
    { mode: MountMode.WRITE },
  )
  try {
    await runMetaCases(redisWs)
  } finally {
    await redisWs.execute('rm -rf /data/metad')
    await redisWs.close()
  }

  console.log('##### s3 (overlay) #####')
  const keyPrefix = `mirage-integ-meta-${String(process.pid)}-${String(Date.now())}/`
  const s3Ws = new Workspace(
    { '/data': s3ResourceFromEnv(keyPrefix) },
    { mode: MountMode.WRITE },
  )
  try {
    await runMetaOverlayCases(s3Ws)
    await runOverlaySnapshotRoundtrip(s3Ws, s3ResourceFromEnv(keyPrefix))
  } finally {
    await s3Ws.close()
  }

  await runSnapshotRoundtrip()
}

main().catch((err: unknown) => {
  process.stderr.write(String(err) + '\n')
  process.exit(1)
})
