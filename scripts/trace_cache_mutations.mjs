import { S3Client } from '../typescript/node_modules/@aws-sdk/client-s3/dist-cjs/index.js'
import { createInterface } from 'node:readline'
import { Workspace } from '../typescript/packages/node/dist/workspace.js'
import { S3VFS } from '../typescript/packages/node/dist/vfs/s3/s3.js'
import '../typescript/packages/node/dist/cache/file/redis.js'
import { MountMode, ReadPolicy } from '../typescript/packages/core/dist/types.js'

const config = JSON.parse(process.env.MIRAGE_CACHE_TRACE_CONFIG)
const api = new Map()
const send = S3Client.prototype.send
S3Client.prototype.send = function (command, ...args) {
  const name = command.constructor.name.replace(/Command$/, '')
  api.set(name, (api.get(name) ?? 0) + 1)
  return send.call(this, command, ...args)
}
const ws = new Workspace(
  {
    '/s3': new S3VFS({
      bucket: config.bucket,
      region: 'us-east-1',
      endpoint: config.endpoint,
      accessKeyId: config.accessKey,
      secretAccessKey: config.secretKey,
      forcePathStyle: true,
    }),
  },
  {
    mode: MountMode.WRITE,
    read: { policy: ReadPolicy.BOUNDED, ttl: 600 },
    cache: { type: 'redis', url: config.redisUrl, keyPrefix: config.prefix + 'cache:' },
    index: { type: 'redis', url: config.redisUrl, keyPrefix: config.prefix + 'idx:' },
  },
)
const lines = createInterface({ input: process.stdin, terminal: false })
try {
  for await (const line of lines) {
    const { command } = JSON.parse(line)
    api.clear()
    const result = await ws.shell(command)
    process.stdout.write(JSON.stringify({
      code: result.exitCode,
      stdout: new TextDecoder().decode(result.stdout),
      stderr: new TextDecoder().decode(result.stderr),
      calls: Object.fromEntries(api),
    }) + '\n')
  }
} finally {
  await ws.close()
  S3Client.prototype.send = send
}
