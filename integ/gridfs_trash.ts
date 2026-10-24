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
import { GridFSVFS, MountMode, Workspace } from '@struktoai/mirage-node'
import type { GridFSConfig } from '@struktoai/mirage-node'
import { MongoClient } from 'mongodb'

const URI = process.env.MONGODB_URI ?? 'mongodb://localhost:27017'
const DEC = new TextDecoder()

type Probe = Record<string, string | number | boolean>

async function shell(
  ws: Workspace,
  line: string,
): Promise<{ exit: number; stdout: string; stderr: string }> {
  const result = await ws.shell(line)
  return {
    exit: result.exitCode,
    stdout: DEC.decode(result.stdout),
    stderr: DEC.decode(result.stderr),
  }
}

/**
 * What a workspace restored from `snap` reads at `/data/f.txt`, past the
 * restored cache, so the pinned stat and read reach the trashed revision
 * itself.
 */
async function restoredReads(
  snap: string,
  config: GridFSConfig,
): Promise<{ pinned: boolean; size: string; cat: string }> {
  // A load leaves the override to its caller, open MongoDB client and all.
  const fresh = new GridFSVFS(config)
  const restored = await Workspace.load(snap, {}, { '/data': fresh })
  try {
    await restored.cache.remove('/data/f.txt')
    return {
      pinned: '/data/f.txt' in restored.revisions,
      size: (await shell(restored, 'stat -c %s /data/f.txt')).stdout,
      cat: (await shell(restored, 'cat /data/f.txt')).stdout,
    }
  } finally {
    await restored.close()
    await fresh.close()
  }
}

/**
 * Snapshot a read, rm the file, and restore: once while the file is still
 * deleted, once after a rewrite. The battery cannot snapshot a workspace or
 * reload it onto a fresh VFS, so this runs here, against the MongoDB the
 * shared battery jobs already start. Twin of `gridfs_trash.py`.
 */
async function probe(config: GridFSConfig): Promise<Probe> {
  // Written by one workspace and read by another, so the read reaches the
  // backend and records the revision the snapshot pins; a read served from
  // the writer's cache records nothing.
  const writer = new Workspace({ '/data': new GridFSVFS(config) }, { mode: MountMode.WRITE })
  try {
    await shell(writer, 'printf v1 > /data/f.txt')
  } finally {
    await writer.close()
  }
  const ws = new Workspace({ '/data': new GridFSVFS(config) }, { mode: MountMode.WRITE })
  const dir = mkdtempSync(join(tmpdir(), 'mirage-gridfs-trash-'))
  const snap = join(dir, 'ws.tar')
  const out: Probe = {}
  try {
    out.before_snapshot = (await shell(ws, 'cat /data/f.txt')).stdout
    await ws.snapshot(snap)
    await shell(ws, 'printf v2 > /data/f.txt')
    await shell(ws, 'rm /data/f.txt')
    const gone = await shell(ws, 'cat /data/f.txt')
    out.after_rm_exit = gone.exit
    out.after_rm_stderr = gone.stderr
    out.after_rm_ls = (await shell(ws, 'ls /data')).stdout
    const deleted = await restoredReads(snap, config)
    out.restored_pinned = deleted.pinned
    out.restored_deleted_size = deleted.size
    out.restored_deleted = deleted.cat
    await shell(ws, 'printf v3 > /data/f.txt')
    out.after_rewrite = (await shell(ws, 'cat /data/f.txt')).stdout
    out.restored = (await restoredReads(snap, config)).cat
  } finally {
    await ws.close()
    rmSync(dir, { recursive: true, force: true })
  }
  return out
}

async function main(): Promise<void> {
  const database = `mirage_integ_trash_${randomUUID().slice(0, 8)}`
  const config: GridFSConfig = { uri: URI, database, bucket: 'data' }
  let result: Probe
  try {
    result = await probe(config)
  } finally {
    const client = new MongoClient(URI)
    try {
      await client.db(database).dropDatabase()
    } finally {
      await client.close()
    }
  }
  console.log(JSON.stringify(result))
}

void main()
