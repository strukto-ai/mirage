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

// SeaweedFS in VFS mode — agent-style workflow using only `ws.shell()`. No FUSE.
//
// Self-contained: seeds a few objects, drives them through the virtual
// executor, then cleans up. Point it at a SeaweedFS S3 gateway (default
// http://localhost:8333). Loads credentials from .env.development at the repo root.
import { MountMode, SeaweedFSVFS, Workspace, type SeaweedFSConfig } from '@struktoai/mirage-node'
import dotenv from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __HERE = dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: resolve(__HERE, '../../../.env.development') })

function configFromEnv(): SeaweedFSConfig {
  return {
    bucket: process.env.SEAWEEDFS_BUCKET ?? 'mirage-demo',
    endpoint: process.env.SEAWEEDFS_ENDPOINT ?? 'http://localhost:8333',
    accessKeyId: process.env.SEAWEEDFS_ACCESS_KEY ?? 'any',
    secretAccessKey: process.env.SEAWEEDFS_SECRET_KEY ?? 'any',
  }
}

async function main(): Promise<void> {
  const cfg = configFromEnv()
  const ws = new Workspace(
    { '/seaweedfs/': new SeaweedFSVFS(cfg) },
    { mode: MountMode.WRITE },
  )

  const run = async (cmd: string): Promise<void> => {
    const r = await ws.shell(cmd)
    const out = r.stdoutText.trimEnd()
    const lines = out ? out.split('\n') : []
    const head = lines[0] ?? ''
    const more = lines.length > 1 ? ` (+${String(lines.length - 1)} more)` : ''
    console.log(`  $ ${cmd}`)
    console.log(`    ${head.slice(0, 110)}${more}  [exit=${String(r.exitCode)}]`)
  }

  try {
    console.log(`=== VFS MODE — SeaweedFS at ${cfg.endpoint} (bucket ${cfg.bucket}) ===\n`)

    // Seed a few objects so the demo is self-contained.
    await ws.shell(
      `echo '{"event":"queue-operation","tool":"mirage"}' > /seaweedfs/data/example.jsonl`,
    )
    await ws.shell(`echo '{"event":"read","tool":"mirage"}' >> /seaweedfs/data/example.jsonl`)
    await ws.shell(
      `echo '{"event":"queue-operation","tool":"other"}' >> /seaweedfs/data/example.jsonl`,
    )
    await ws.shell(
      `echo '{"name":"mirage","version":1,"tags":["s3","seaweedfs"]}' > /seaweedfs/data/config.json`,
    )
    await ws.shell('echo "hello from seaweedfs" > /seaweedfs/notes.txt')

    console.log('[listings]')
    await run('ls /seaweedfs')
    await run('ls -1 /seaweedfs/data')

    console.log('\n[stat / exists]')
    await run('stat /seaweedfs/data/example.jsonl')
    await run('test -f /seaweedfs/data/example.jsonl && echo present || echo absent')
    await run('test -f /seaweedfs/data/no-such.txt && echo present || echo absent')

    console.log('\n[read]')
    await run('head -n 1 /seaweedfs/data/example.jsonl')
    await run('wc -l /seaweedfs/data/example.jsonl')
    await run('wc -c /seaweedfs/data/config.json')

    console.log('\n[grep / rg]')
    await run('grep -c queue-operation /seaweedfs/data/example.jsonl')
    await run('grep -m 1 mirage /seaweedfs/data/example.jsonl')
    await run('rg -l mirage /seaweedfs')

    console.log('\n[find / glob]')
    await run("find /seaweedfs -name '*.json'")
    await run('echo /seaweedfs/data/*.json')

    console.log('\n[jq]')
    await run('jq .tags /seaweedfs/data/config.json')

    console.log('\n[pipelines]')
    await run('cat /seaweedfs/data/example.jsonl | grep mirage | wc -l')

    console.log('\n[cleanup]')
    for (const key of [
      '/seaweedfs/data/example.jsonl',
      '/seaweedfs/data/config.json',
      '/seaweedfs/notes.txt',
    ]) {
      await ws.shell(`rm ${key}`)
    }
    console.log('  cleaned')
  } finally {
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
