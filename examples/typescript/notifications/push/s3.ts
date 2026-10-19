import { readFile } from 'node:fs/promises'
import { S3VFS, PathSpec, Workspace } from '@struktoai/mirage-node'
import { S3EventHook } from '@struktoai/mirage-core/core/s3/events'
import type { JsonValue } from '@struktoai/mirage-core/types'

async function main(): Promise<void> {
  const file = process.argv[2]
  const bucket = process.env.S3_BUCKET
  if (!file || !bucket) throw new Error('Set S3_BUCKET and pass a notification JSON file')
  const payload = JSON.parse(await readFile(file, 'utf8')) as {
    Records: (Record<string, JsonValue> & { eventName: string })[]
  }
  const vfs = new S3VFS({ bucket })
  const ws = new Workspace({ '/s3': vfs })
  const hook = new S3EventHook(vfs.accessor)
  const root = PathSpec.fromStrPath('/s3', '')
  try {
    for (const record of payload.Records) {
      for (const change of await hook.toEvents(root, record.eventName, record)) {
        await ws.notify(change)
        console.log(`${change.kind}: ${change.path.virtual}`)
      }
    }
  } finally {
    await ws.close()
  }
}

await main()
