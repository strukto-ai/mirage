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

// The GridFS trash under a snapshot: rm retags revisions instead of
// deleting them, so a workspace restored from a snapshot taken before the
// rm still reads the revision it pinned. The declarative battery cannot
// snapshot a workspace or reload it onto a fresh VFS, so this probe does,
// against the MongoDB the shared battery jobs already run. Emits one JSON
// line for integ/check_json.py against integ/truth_gridfs_trash.json, the
// same truth file the Python twin is checked against.

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

async function probe(config: GridFSConfig): Promise<Probe> {
  // The file is written by one workspace and read by another, so the read
  // reaches the backend and records the revision the snapshot pins; a read
  // served from the writer's cache records nothing.
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
    await shell(ws, 'printf v3 > /data/f.txt')
    out.after_rewrite = (await shell(ws, 'cat /data/f.txt')).stdout
    // The override stays the caller's: closing the restored workspace does
    // not close it, and an open MongoDB client keeps the process alive.
    const fresh = new GridFSVFS(config)
    const restored = await Workspace.load(snap, {}, { '/data': fresh })
    try {
      out.restored_pinned = '/data/f.txt' in restored.revisions
      // Past the restored cache: the pinned read has to reach the trashed
      // revision itself.
      await restored.cache.remove('/data/f.txt')
      out.restored = (await shell(restored, 'cat /data/f.txt')).stdout
    } finally {
      await restored.close()
      await fresh.close()
    }
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
