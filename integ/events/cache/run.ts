import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import {
  type FileChangeKind,
  FileEvent,
  MountMode,
  PathSpec,
  RAMEventQueue,
  S3VFS,
  Workspace,
  EventHub,
} from '@struktoai/mirage-node'

interface Check {
  command: string
  stdout: string
  exit?: number
  stale?: boolean
}

interface Case {
  id: string
  seed: Record<string, string>
  warm: Check[]
  write?: Record<string, string>
  delete?: string[]
  event: { kind: FileChangeKind; path: string; previous?: string }
  checks: Check[]
}

class ArmedQueue extends RAMEventQueue {
  private arm!: () => void
  readonly armed = new Promise<void>((resolve) => {
    this.arm = resolve
  })

  override pop(): Promise<FileEvent> {
    this.arm()
    return super.pop()
  }
}

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing ${name}`)
  return value
}

async function check(ws: Workspace, root: string, expected: Check): Promise<void> {
  const command = expected.command.replaceAll('{root}', root)
  const result = await ws.shell(command)
  const decoder = new TextDecoder()
  assert.deepEqual(
    [result.exitCode, decoder.decode(result.stdout), decoder.decode(result.stderr)],
    [expected.exit ?? 0, expected.stdout, ''],
    command,
  )
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Event delivery timed out')), 10_000)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function runCase(mount: string, test: Case): Promise<void> {
  const prefix = `events-cache-${randomUUID()}/`
  const root = mount + mount
  const bucket = required('S3_BUCKET')
  const endpoint = required('S3_ENDPOINT')
  const region = process.env.S3_REGION ?? 'us-east-1'
  const credentials = {
    accessKeyId: required('AWS_ACCESS_KEY_ID'),
    secretAccessKey: required('AWS_SECRET_ACCESS_KEY'),
  }
  const client = new S3Client({ endpoint, region, credentials, forcePathStyle: true })
  const ws = new Workspace(
    {
      [mount]: new S3VFS({
        bucket,
        endpoint,
        region,
        ...credentials,
        forcePathStyle: true,
        keyPrefix: prefix,
      }),
    },
    { mode: MountMode.WRITE, index: { type: 'ram', ttl: 600 } },
  )
  const queue = new ArmedQueue(PathSpec.fromStrPath(root))
  ws.attachEventRuntime(new EventHub(ws.registry, () => queue))
  const stream = ws.events(root)[Symbol.asyncIterator]()
  const touched = new Set<string>()
  const key = (relative: string): string => prefix + mount.slice(1) + '/' + relative
  let pending: Promise<void> | undefined
  try {
    for (const [relative, body] of Object.entries(test.seed)) {
      touched.add(key(relative))
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key(relative), Body: body }))
    }
    for (const expected of test.warm) await check(ws, root, expected)
    for (const [relative, body] of Object.entries(test.write ?? {})) {
      touched.add(key(relative))
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key(relative), Body: body }))
    }
    for (const relative of test.delete ?? []) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key(relative) }))
    }
    for (const expected of test.warm) {
      if (expected.stale !== false) await check(ws, root, expected)
    }

    const path = root + '/' + test.event.path
    const previous = test.event.previous === undefined ? null : root + '/' + test.event.previous
    pending = (async () => {
      const delivered = await stream.next()
      assert.equal(delivered.done, false)
      assert.equal(delivered.value.kind, test.event.kind)
      assert.equal(delivered.value.path.virtual, path)
      assert.equal(delivered.value.path.vfsPath, path.slice(mount.length + 1))
      assert.equal(delivered.value.previousPath?.virtual ?? null, previous)
      for (const expected of test.checks) await check(ws, root, expected)
    })()
    await bounded(queue.armed)
    await ws.notify(
      new FileEvent({
        kind: test.event.kind,
        path: PathSpec.fromStrPath(path),
        previousPath: previous === null ? null : PathSpec.fromStrPath(previous),
        timestamp: new Date(),
      }),
    )
    await bounded(pending)
    process.stdout.write(`PASS typescript ${mount} ${test.id}\n`)
  } finally {
    await ws.close()
    try {
      await pending
    } finally {
      await stream.return?.()
      try {
        for (const staleKey of touched) {
          await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: staleKey }))
        }
      } finally {
        client.destroy()
      }
    }
  }
}

const spec = JSON.parse(await readFile(new URL('./cases.json', import.meta.url), 'utf8')) as {
  mounts: string[]
  cases: Case[]
}
for (const mount of spec.mounts) {
  for (const test of spec.cases) await runCase(mount, test)
}
