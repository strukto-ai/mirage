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

// Full read+write S3 demo against a local MinIO running in Docker.
//
// Starts assuming MinIO is up on http://localhost:9000 with the default
// minioadmin/minioadmin credentials. Start it with:
//
//   docker run --rm -d --name mirage-minio \
//     -p 9000:9000 -p 9001:9001 \
//     -e MINIO_ROOT_USER=minioadmin \
//     -e MINIO_ROOT_PASSWORD=minioadmin \
//     quay.io/minio/minio server /data --console-address ':9001'
//
// The example exercises the full S3Resource surface: writes (tee, cp, mv,
// rm, mkdir), reads (cat, head, grep, wc), find, and the du/rmR helpers.
// At the end it clears all keys it wrote so the demo is reproducible.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ContentDriftError,
  DriftPolicy,
  MountMode,
  S3Resource,
  Workspace,
  type S3Config,
} from '@struktoai/mirage-node'

const DEC = new TextDecoder()

const config: S3Config = {
  bucket: 'mirage-demo',
  region: 'us-east-1',
  endpoint: 'http://localhost:9000',
  accessKeyId: 'minioadmin',
  secretAccessKey: 'minioadmin',
  forcePathStyle: true,
}

async function ensureBucket(): Promise<void> {
  // The S3Resource never creates buckets — that's an administrative action.
  // We do it inline here so the demo is self-contained.
  const sdk = await import('@aws-sdk/client-s3')
  const client = new sdk.S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: config.accessKeyId!, secretAccessKey: config.secretAccessKey! },
  })
  try {
    await client.send(new sdk.CreateBucketCommand({ Bucket: config.bucket }))
    console.log(`created bucket: ${config.bucket}`)
  } catch (err) {
    const code = (err as { name?: string; Code?: string }).name ?? (err as { Code?: string }).Code
    if (code === 'BucketAlreadyOwnedByYou' || code === 'BucketAlreadyExists') {
      console.log(`bucket already exists: ${config.bucket}`)
    } else {
      throw err
    }
  } finally {
    client.destroy()
  }
}

async function tryEnableVersioning(): Promise<boolean> {
  const sdk = await import('@aws-sdk/client-s3')
  const client = new sdk.S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: config.accessKeyId!, secretAccessKey: config.secretAccessKey! },
  })
  try {
    await client.send(
      new sdk.PutBucketVersioningCommand({
        Bucket: config.bucket,
        VersioningConfiguration: { Status: 'Enabled' },
      }),
    )
    const resp = await client.send(
      new sdk.GetBucketVersioningCommand({ Bucket: config.bucket }),
    )
    return resp.Status === 'Enabled'
  } catch {
    return false
  } finally {
    client.destroy()
  }
}

async function putObjectViaSdk(key: string, body: string): Promise<void> {
  const sdk = await import('@aws-sdk/client-s3')
  const client = new sdk.S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: config.accessKeyId!, secretAccessKey: config.secretAccessKey! },
  })
  try {
    await client.send(
      new sdk.PutObjectCommand({ Bucket: config.bucket, Key: key, Body: body }),
    )
  } finally {
    client.destroy()
  }
}

async function deleteObjectViaSdk(key: string): Promise<void> {
  const sdk = await import('@aws-sdk/client-s3')
  const client = new sdk.S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: config.accessKeyId!, secretAccessKey: config.secretAccessKey! },
  })
  try {
    await client.send(new sdk.DeleteObjectCommand({ Bucket: config.bucket, Key: key }))
  } catch {
    // Best-effort cleanup; ignore tombstone artifacts on versioned buckets.
  } finally {
    client.destroy()
  }
}

async function driftAndPinDemo(): Promise<void> {
  console.log('\n=== DRIFT + VERSION PIN ===\n')
  const versioned = await tryEnableVersioning()
  console.log(`  bucket versioning: ${versioned ? 'enabled' : 'unavailable (drift only)'}`)

  const probeKey = `drift-probe-${Math.random().toString(36).slice(2, 10)}.txt`
  const probeVirtual = `/s3/${probeKey}`
  await putObjectViaSdk(probeKey, 'original\n')

  const ws = new Workspace({ '/s3/': new S3Resource(config) }, { mode: MountMode.WRITE })
  const tempDir = mkdtempSync(join(tmpdir(), 'mirage-drift-'))
  const snap = join(tempDir, 'pin.json')
  try {
    const readRes = await ws.execute(`cat ${probeVirtual}`)
    console.log(`  agent saw: ${JSON.stringify(readRes.stdoutText.trim())}`)
    const size = await ws.snapshot(snap)
    console.log(`  snapshot: ${snap} (${String(size)} bytes)`)

    await putObjectViaSdk(probeKey, 'mutated\n')
    console.log('  upstream mutated to "mutated"')

    const loaded = await Workspace.load(
      snap,
      { mode: MountMode.WRITE, driftPolicy: DriftPolicy.STRICT },
      { '/s3/': new S3Resource(config) },
    )
    const pinned = Object.keys(loaded.revisions)
    console.log(`  installed pins: ${pinned.length === 0 ? '(none)' : pinned.join(', ')}`)
    try {
      const replay = await loaded.execute(`cat ${probeVirtual}`)
      const served = replay.stdoutText.trim()
      if (versioned && served === 'original') {
        console.log(`  STRICT load -> served: ${JSON.stringify(served)} (OK pin served original)`)
      } else if (!versioned) {
        console.log(`  STRICT load -> served: ${JSON.stringify(served)} (no pin available)`)
      } else {
        console.log(`  STRICT load -> served: ${JSON.stringify(served)} (UNEXPECTED)`)
      }
    } catch (err) {
      if (err instanceof ContentDriftError) {
        console.log(`  STRICT load raised ContentDriftError as expected: ${err.path}`)
      } else {
        throw err
      }
    } finally {
      await loaded.close()
    }
  } finally {
    await ws.close()
    await deleteObjectViaSdk(probeKey)
  }
}

function print(bytes: Uint8Array): void {
  process.stdout.write(DEC.decode(bytes) + '\n')
}

async function runLabeled(ws: Workspace, label: string, cmd: string): Promise<void> {
  console.log(`=== ${label} ===`)
  const res = await ws.execute(cmd)
  print(res.stdout)
}

async function main(): Promise<void> {
  await ensureBucket()
  const ws = new Workspace({ '/s3/': new S3Resource(config) }, { mode: MountMode.WRITE })
  try {
    // Pre-clean any leftovers from a previous run.
    await ws.execute('rm -rf /s3/demo')

    console.log('=== tee — create files ===')
    await ws.execute('echo "hello from s3" | tee /s3/demo/hello.txt')
    await ws.execute('printf "line1\\nline2\\nline3\\n" | tee /s3/demo/multi.txt')
    await ws.execute(`echo '{"name":"alice","age":30}' | tee /s3/demo/user.json`)
    await ws.execute('mkdir /s3/demo/reports')
    await ws.execute('printf "revenue,100\\nexpense,80\\n" | tee /s3/demo/reports/q1.csv')

    await runLabeled(ws, 'ls /s3/demo/', 'ls /s3/demo/')
    await runLabeled(ws, 'cat /s3/demo/hello.txt', 'cat /s3/demo/hello.txt')
    await runLabeled(ws, 'wc -l /s3/demo/multi.txt', 'wc -l /s3/demo/multi.txt')
    await runLabeled(ws, 'head -n 1 /s3/demo/reports/q1.csv', 'head -n 1 /s3/demo/reports/q1.csv')
    await runLabeled(ws, 'grep line2 /s3/demo/multi.txt', 'grep line2 /s3/demo/multi.txt')
    await runLabeled(ws, 'jq .name /s3/demo/user.json', 'jq ".name" /s3/demo/user.json')
    await runLabeled(ws, 'stat /s3/demo/hello.txt', 'stat /s3/demo/hello.txt')

    console.log('=== cp /s3/demo/hello.txt /s3/demo/hello_copy.txt ===')
    await ws.execute('cp /s3/demo/hello.txt /s3/demo/hello_copy.txt')
    await runLabeled(ws, 'cat hello_copy.txt', 'cat /s3/demo/hello_copy.txt')

    console.log('=== mv /s3/demo/hello_copy.txt /s3/demo/renamed.txt ===')
    await ws.execute('mv /s3/demo/hello_copy.txt /s3/demo/renamed.txt')
    await runLabeled(ws, 'ls /s3/demo/', 'ls /s3/demo/')

    console.log('=== rm /s3/demo/renamed.txt ===')
    await ws.execute('rm /s3/demo/renamed.txt')
    await runLabeled(ws, 'ls /s3/demo/', 'ls /s3/demo/')

    await runLabeled(ws, 'du /s3/demo/', 'du /s3/demo/')
    await runLabeled(ws, "find /s3/demo/ -name '*.txt'", `find /s3/demo/ -name '*.txt'`)

    console.log('\n=== CLEANUP ===')
    await ws.execute('rm -rf /s3/demo')
    console.log('  all demo keys removed')
  } finally {
    await ws.close()
  }

  await driftAndPinDemo()
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
