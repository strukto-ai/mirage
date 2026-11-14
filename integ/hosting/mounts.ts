import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3'
import { start } from '../server/kit/typescript/index.ts'
import { slackFake } from '../server/slack/fake.ts'
import type { C } from '../server/slack/config.ts'

interface Gate {
  entered: boolean
  wait: Promise<void>
  release: () => void
}

const probe = `from pathlib import Path
identity = Path('/work/identity.txt').read_text()
for mount in ['/work', '/s3', '/redis']:
    assert Path(mount + '/identity.txt').read_text() == identity
    target = Path(mount + '/probe-' + argv[1] + '.txt')
    target.write_text(identity + ':' + argv[1])
    assert target.read_text() == identity + ':' + argv[1]
assert 'Priya Nair' in Path('/slack/users/priya__U7.json').read_text()
print(identity + ':' + argv[1] + ':ram,s3,redis,slack')
`

export async function startMounts(tenants: string[]) {
  const endpoint = process.env.S3_ENDPOINT
  const redis = process.env.REDIS_URL
  assert(endpoint, '--mounts requires S3_ENDPOINT; mount coverage must not silently skip')
  assert(redis, '--mounts requires REDIS_URL; mount coverage must not silently skip')
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID ?? 'minio'
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY ?? 'minio123'
  const scope = randomUUID()
  const bucket = `mirage-hosting-${scope}`
  const client = new S3Client({
    region: 'us-east-1',
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  })
  const gates = new Map<string, Gate>()
  const slack = await start<C>(
    {
      ...slackFake,
      defaultTenants: tenants,
      routes: () =>
        slackFake.routes().map((route) => ({
          ...route,
          handler: async (ctx) => {
            const gate = gates.get(ctx.tenant)
            if (route.path === '/files/download/:id' && gate !== undefined && !gate.entered) {
              gate.entered = true
              await gate.wait
            }
            return route.handler(ctx)
          },
        })),
    },
    0,
    'hosting',
  )
  try {
    await client.send(new CreateBucketCommand({ Bucket: bucket }))
  } catch (error) {
    await slack.close()
    client.destroy()
    throw error
  }
  return {
    arm(tenant: string): Gate {
      let release!: () => void
      const wait = new Promise<void>((resolve) => {
        release = resolve
      })
      const gate = { entered: false, wait, release }
      gates.set(tenant, gate)
      return gate
    },
    config(tenant: string) {
      return {
        mode: 'exec',
        machines: { py: { provider: 'in_process', runtime: 'monty' } },
        mounts: {
          '/work': { vfs: 'ram', mode: 'exec' },
          '/s3': {
            vfs: 's3',
            mode: 'write',
            config: {
              bucket,
              endpoint_url: endpoint,
              region: 'us-east-1',
              path_style: true,
              key_prefix: tenant,
              aws_access_key_id: accessKeyId,
              aws_secret_access_key: secretAccessKey,
            },
          },
          '/redis': {
            vfs: 'redis',
            mode: 'write',
            config: { url: redis, key_prefix: `hosting:${scope}:${tenant}:` },
          },
          '/slack': {
            vfs: 'slack',
            mode: 'read',
            config: { token: `xoxb-${tenant}`, base_url: `${slack.endpoint}/api` },
          },
        },
      }
    },
    seed(tenant: string) {
      const files = {
        'identity.txt': tenant,
        'probe.py': probe,
        'hold.py':
          "from pathlib import Path\nassert Path('/slack/channels/general__C1/2026-01-01/files/hold__F1.txt').read_text() == 'released\\n'\nprint('released')\n",
        'busy.py':
          "from pathlib import Path\nPath('/work/started').write_text('started')\nwhile True:\n    pass\n",
      }
      return (
        Object.entries(files)
          .map(([name, text]) => `printf %s '${text.replaceAll("'", "'\\''")}' > /work/${name}`)
          .join(' && ') +
        ' && cp /work/identity.txt /s3/identity.txt && cp /work/identity.txt /redis/identity.txt && python3 --version'
      )
    },
    async close() {
      for (const gate of gates.values()) gate.release()
      try {
        await slack.close()
        const objects = await client.send(new ListObjectsV2Command({ Bucket: bucket }))
        if (objects.Contents?.length) {
          const deleted = await client.send(
            new DeleteObjectsCommand({
              Bucket: bucket,
              Delete: { Objects: objects.Contents.map(({ Key }) => ({ Key })) },
            }),
          )
          assert(!deleted.Errors?.length, JSON.stringify(deleted.Errors))
        }
        await client.send(new DeleteBucketCommand({ Bucket: bucket }))
      } finally {
        client.destroy()
      }
    },
  }
}
