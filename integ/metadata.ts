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

// The per-command metadata cases this file used to run now live in
// integ/unix/meta and integ/unix/meta_overlay, where the JSON battery runs
// them on 22 backends instead of the four here. What is left are the three
// scenarios the declarative harness cannot express: it can run commands and
// stat paths, but it cannot snapshot a workspace, reload it onto a fresh
// resource, or mutate a backend out of band. Retiring these needs snapshot
// and namespace support in the harness, not another case file.

import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FileStat } from '@struktoai/mirage-node'
import {
  ConsistencyPolicy,
  MountMode,
  RAMResource,
  S3Resource,
  Workspace,
} from '@struktoai/mirage-node'

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

// Kept local now that cases.ts is gone: four fields, and the mtime slice keeps
// the Z vs +00:00 suffix out of the byte-diffed truth file.
function metaStatLine(st: FileStat, fields: ReadonlyArray<string>): string {
  return fields
    .map((field) => {
      if (field === 'mode') return `mode=${st.mode !== undefined ? st.mode.toString(8) : '-'}`
      if (field === 'uid') return `uid=${st.uid !== undefined ? String(st.uid) : '-'}`
      if (field === 'gid') return `gid=${st.gid !== undefined ? String(st.gid) : '-'}`
      return `mtime=${st.modified !== undefined ? st.modified.slice(0, 19) : '-'}`
    })
    .join(' ')
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

async function runOverlayOrphanGc(keyPrefix: string): Promise<void> {
  // A chmod on a slot-less backend (s3) creates an attribute overlay. When
  // the object is deleted out-of-band (raw op, another agent), the overlay
  // is orphaned. Under ALWAYS, a single-mount shell stat the backend reports
  // gone must GC that orphaned node.
  const ws = new Workspace(
    { '/data': s3ResourceFromEnv(keyPrefix) },
    { mode: MountMode.WRITE, consistency: ConsistencyPolicy.ALWAYS },
  )
  try {
    await ws.execute('echo alpha > /data/g.txt && chmod 601 /data/g.txt')
    const before = ws.namespace.metaFor('/data/g.txt') !== null
    // Out-of-band delete: dispatch the raw unlink op (not the rm command, which
    // would drop the namespace node itself), leaving the overlay orphaned.
    await ws.dispatch('unlink', '/data/g.txt')
    await ws.execute('stat /data/g.txt')
    const after = ws.namespace.metaFor('/data/g.txt') !== null
    console.log('=== overlay_orphan_gc ===')
    console.log(`before=${before ? 'True' : 'False'} after=${after ? 'True' : 'False'}`)
  } finally {
    await ws.close()
  }
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
  const prefix = `mirage-integ-meta-${randomUUID().slice(0, 8)}/`
  const s3Ws = new Workspace(
    { '/data': s3ResourceFromEnv(prefix) },
    { mode: MountMode.WRITE },
  )
  try {
    await runOverlaySnapshotRoundtrip(s3Ws, s3ResourceFromEnv(prefix))
  } finally {
    await s3Ws.close()
  }
  await runOverlayOrphanGc(`${prefix}gc/`)
  await runSnapshotRoundtrip()
}

void main()
