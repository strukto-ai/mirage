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

// S3 in VFS mode — agent-style workflow using only `ws.shell()`. No FUSE.
//
// Two mounts:
//   /s3/    — unscoped, full bucket
//   /deep/  — same bucket, scoped to subdata/subsubdata/ via keyPrefix.
//             /deep/example.jsonl resolves to s3://<bucket>/subdata/subsubdata/example.jsonl
//
// Loads credentials from .env.development at the repo root.
import { MountMode, S3VFS, Workspace, type S3Config } from '@struktoai/mirage-node'
import dotenv from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __HERE = dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: resolve(__HERE, '../../../.env.development') })

function baseConfig(): S3Config {
  if (process.env.AWS_S3_BUCKET === undefined) {
    throw new Error('AWS_S3_BUCKET not set (expected in .env.development)')
  }
  return {
    bucket: process.env.AWS_S3_BUCKET,
    region: process.env.AWS_DEFAULT_REGION ?? 'us-east-1',
    ...(process.env.AWS_ACCESS_KEY_ID !== undefined &&
    process.env.AWS_SECRET_ACCESS_KEY !== undefined
      ? {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        }
      : {}),
  }
}

async function main(): Promise<void> {
  const cfg = baseConfig()
  const deepCfg: S3Config = { ...cfg, keyPrefix: 'subdata/subsubdata/' }

  const ws = new Workspace(
    {
      '/s3/': new S3VFS(cfg),
      '/deep/': new S3VFS(deepCfg),
    },
    { mode: MountMode.READ },
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
    console.log(`=== VFS MODE — bucket: ${cfg.bucket} ===\n`)
    console.log(`  keyPrefix on /deep = ${JSON.stringify(deepCfg.keyPrefix)}\n`)

    console.log('[listings]')
    await run('ls /deep')
    await run('ls -1 /deep')

    console.log('\n[stat / exists]')
    await run('stat /deep/example.jsonl')
    await run('test -f /deep/example.jsonl && echo present || echo absent')
    await run('test -f /deep/no-such.txt && echo present || echo absent')

    console.log('\n[read]')
    await run('head -n 1 /deep/example.jsonl')
    await run('wc -l /deep/example.jsonl')
    await run('wc -c /deep/example.json')

    console.log('\n[grep / rg]')
    await run('grep -c mirage /deep/example.jsonl')
    await run('grep -m 1 mirage /deep/example.jsonl')
    await run('rg -l mirage /deep')
    await run('rg -c mirage /deep/example.json')

    console.log('\n[find / glob]')
    await run("find /deep -name '*.json'")
    await run('find /deep -type f | wc -l')
    await run('echo /deep/*.json')

    console.log('\n[jq]')
    await run('jq .metadata.version /deep/example.json')

    console.log('\n[pipelines]')
    await run('cat /deep/example.jsonl | grep mirage | wc -l')
    await run('grep -m 1 mirage /deep/example.jsonl && echo found')

    console.log('\n[parity: /deep vs /s3/subdata/subsubdata/]')
    const a = (await ws.shell('grep -c mirage /deep/example.jsonl')).stdoutText.trim()
    const b = (
      await ws.shell('grep -c mirage /s3/subdata/subsubdata/example.jsonl')
    ).stdoutText.trim()
    console.log(`  /deep/example.jsonl                       grep -c: ${a}`)
    console.log(`  /s3/subdata/subsubdata/example.jsonl      grep -c: ${b}`)
    console.log(`  parity: ${String(a === b)}`)
  } finally {
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
