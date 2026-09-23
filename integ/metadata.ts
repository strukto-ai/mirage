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
// VFS, or mutate a backend out of band. Retiring these needs snapshot
// and namespace support in the harness, not another case file.
//
// Emits its result as one JSON line for integ/check_json.py, the same truth
// file the Python twin is checked against. That is why `before`/`after` are
// real booleans here: the byte-diffed truth file this replaced forced this
// side to print Python's `True`/`False` spelling.

import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FileStat } from '@struktoai/mirage-node'
import {
  DEFAULT_READ_TTL,
  MountMode,
  RAMVFS,
  ReadPolicy,
  S3VFS,
  Workspace,
} from '@struktoai/mirage-node'

function s3VfsFromEnv(keyPrefix: string): S3VFS {
  const bucket = process.env.S3_BUCKET
  if (bucket === undefined || bucket === '') {
    throw new Error('S3_BUCKET env required (point at MinIO or AWS bucket)')
  }
  const endpoint = process.env.S3_ENDPOINT
  const region = process.env.S3_REGION ?? 'us-east-1'
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY
  return new S3VFS({
    bucket,
    region,
    keyPrefix,
    ...(endpoint !== undefined && endpoint !== '' ? { endpoint, forcePathStyle: true } : {}),
    ...(accessKeyId !== undefined && accessKeyId !== '' ? { accessKeyId } : {}),
    ...(secretAccessKey !== undefined && secretAccessKey !== '' ? { secretAccessKey } : {}),
  })
}

// uid and gid are `number | string | null` in both languages, so they are
// normalized to text rather than left to serialize as whichever the backend
// happened to store. The mtime slice keeps the Z vs +00:00 suffix out of the
// truth file.
function overlayStatFields(st: FileStat): Record<string, string | null> {
  return {
    overlay_snapshot_mode: st.mode !== undefined && st.mode !== null ? st.mode.toString(8) : null,
    overlay_snapshot_uid: st.uid !== undefined && st.uid !== null ? String(st.uid) : null,
    overlay_snapshot_gid: st.gid !== undefined && st.gid !== null ? String(st.gid) : null,
    overlay_snapshot_mtime:
      st.modified !== undefined && st.modified !== null ? st.modified.slice(0, 19) : null,
  }
}

async function runOverlaySnapshotRoundtrip(
  ws: Workspace,
  fresh: S3VFS,
): Promise<Record<string, string | null>> {
  // Overlay attrs live in namespace NODES, so they must survive a
  // snapshot even though the s3 VFS is rebuilt fresh at load
  // (s3 snapshots redact creds and require a VFS override).
  await ws.shell('echo alpha > /data/f.txt')
  await ws.shell(
    'chmod 601 /data/f.txt && chown 500:dev /data/f.txt && touch -t 202601021530 /data/f.txt',
  )
  const dir = mkdtempSync(join(tmpdir(), 'mirage-meta-osnap-'))
  const snap = join(dir, 'ws.tar')
  await ws.snapshot(snap)
  const restored = await Workspace.load(snap, {}, { '/data': fresh })
  const st = (await restored.dispatch('stat', '/data/f.txt')) as FileStat
  await restored.shell('rm /data/f.txt')
  await restored.close()
  rmSync(dir, { recursive: true, force: true })
  return overlayStatFields(st)
}

async function runOverlayOrphanGc(keyPrefix: string): Promise<Record<string, boolean>> {
  // A chmod on a slot-less backend (s3) creates an attribute overlay. When
  // the object is deleted out-of-band (raw op, another agent), the overlay
  // is orphaned. Under `read: fresh`, a single-mount shell stat the backend reports
  // gone must GC that orphaned node.
  const ws = new Workspace(
    { '/data': s3VfsFromEnv(keyPrefix) },
    { mode: MountMode.WRITE, read: { policy: ReadPolicy.FRESH, ttl: DEFAULT_READ_TTL } },
  )
  try {
    await ws.shell('echo alpha > /data/g.txt && chmod 601 /data/g.txt')
    const before = ws.namespace.metaFor('/data/g.txt') !== null
    // Out-of-band delete: dispatch the raw unlink op (not the rm command, which
    // would drop the namespace node itself), leaving the overlay orphaned.
    await ws.dispatch('unlink', '/data/g.txt')
    await ws.shell('stat /data/g.txt')
    const after = ws.namespace.metaFor('/data/g.txt') !== null
    return { overlay_orphan_before: before, overlay_orphan_after: after }
  } finally {
    await ws.close()
  }
}

async function runSnapshotRoundtrip(): Promise<Record<string, string>> {
  const ws = new Workspace({ '/data': new RAMVFS() }, { mode: MountMode.WRITE })
  await ws.shell('echo alpha > /data/f.txt')
  await ws.shell(
    'chmod 601 /data/f.txt && chown 500:dev /data/f.txt && touch -t 202601021530 /data/f.txt',
  )
  const dir = mkdtempSync(join(tmpdir(), 'mirage-meta-snap-'))
  const snap = join(dir, 'ws.tar')
  await ws.snapshot(snap)
  const restored = await Workspace.load(snap)
  const result = await restored.shell('ls -l /data')
  const line = new TextDecoder().decode(result.stdout).trimEnd()
  await ws.close()
  await restored.close()
  rmSync(dir, { recursive: true, force: true })
  return { snapshot_ls_line: line }
}

async function main(): Promise<void> {
  const prefix = `mirage-integ-meta-${randomUUID().slice(0, 8)}/`
  const s3Ws = new Workspace({ '/data': s3VfsFromEnv(prefix) }, { mode: MountMode.WRITE })
  const result: Record<string, string | boolean | null> = {}
  try {
    Object.assign(result, await runOverlaySnapshotRoundtrip(s3Ws, s3VfsFromEnv(prefix)))
  } finally {
    await s3Ws.close()
  }
  Object.assign(result, await runOverlayOrphanGc(`${prefix}gc/`))
  Object.assign(result, await runSnapshotRoundtrip())
  console.log(JSON.stringify(result))
}

void main()
