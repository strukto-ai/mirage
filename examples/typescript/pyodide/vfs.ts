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

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import {
  GDocsResource,
  LinearResource,
  MountMode,
  RAMResource,
  S3Resource,
  Workspace,
  type GDocsConfig,
  type LinearConfig,
  type S3Config,
} from '@struktoai/mirage-node'

const __HERE = fileURLToPath(new URL('.', import.meta.url))
dotenv.config({ path: resolve(__HERE, '../../../.env.development'), override: true })

function buildLinear(): LinearConfig | undefined {
  const apiKey = process.env.LINEAR_API_KEY
  return apiKey === undefined || apiKey === '' ? undefined : { apiKey }
}

function buildGDocs(): GDocsConfig | undefined {
  const clientId = process.env.GOOGLE_CLIENT_ID ?? ''
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? ''
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN ?? ''
  if (clientId === '' || clientSecret === '' || refreshToken === '') return undefined
  return { clientId, clientSecret, refreshToken }
}

function buildS3(): S3Config | undefined {
  const bucket = process.env.AWS_S3_BUCKET ?? ''
  const region = process.env.AWS_DEFAULT_REGION ?? process.env.AWS_REGION ?? ''
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID ?? ''
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY ?? ''
  if (bucket === '' || region === '' || accessKeyId === '' || secretAccessKey === '') return undefined
  return { bucket, region, accessKeyId, secretAccessKey }
}

async function py(ws: Workspace, label: string, code: string): Promise<void> {
  console.log(`\n--- ${label} ---`)
  await ws.fs.writeFile('/ram/__demo.py', code)
  const r = await ws.execute('python3 /ram/__demo.py')
  if (r.stdoutText !== '') process.stdout.write(r.stdoutText)
  if (r.exitCode !== 0) console.error(`  exit=${String(r.exitCode)} ${r.stderrText.trim().slice(0, 200)}`)
}

async function main(): Promise<void> {
  const ws = new Workspace({}, { mode: MountMode.EXEC })
  ws.addMount('/ram', new RAMResource(), MountMode.WRITE)

  const linear = buildLinear()
  if (linear !== undefined) ws.addMount('/linear', new LinearResource(linear), MountMode.READ)
  const gdocs = buildGDocs()
  if (gdocs !== undefined) ws.addMount('/gdocs', new GDocsResource(gdocs), MountMode.READ)
  const s3 = buildS3()
  if (s3 !== undefined) ws.addMount('/s3', new S3Resource(s3), MountMode.READ)

  console.log('Mounts:', ws.mounts().map((m) => m.prefix).join(', '))

  try {
    // 1. Plain RAM read+write — the simplest case.
    await ws.fs.writeFile('/ram/hello.txt', 'world')
    await py(
      ws,
      '1. RAM read+write via Python open()',
      `
with open('/ram/hello.txt') as f:
    print('read:', f.read())
with open('/ram/out.txt', 'w') as f:
    f.write('written from python')
print('wrote /ram/out.txt')
`,
    )
    console.log('host sees:', await ws.fs.readFileText('/ram/out.txt'))

    // 2. Lazy-on-miss — host writes a new path AFTER preload; Python still sees it.
    await ws.execute('mkdir -p /ram/synth/today')
    await ws.fs.writeFile('/ram/synth/today/note.md', 'lazy demo')
    await py(
      ws,
      '2. Lazy-on-miss: a path the preload never walked',
      `
import os
print('listdir:', os.listdir('/ram/synth/today'))
print('read:', open('/ram/synth/today/note.md').read())
`,
    )

    // 3. Cloud reads (skip when creds missing).
    if (linear !== undefined) {
      await py(
        ws,
        '3. Linear: read team JSON via Python',
        `
import os, json
teams = sorted(os.listdir('/linear/teams'))[:1]
if teams:
    team = json.load(open(f'/linear/teams/{teams[0]}/team.json'))
    print('team:', team.get('name'), team.get('id'))
`,
      )
    }
    if (gdocs !== undefined) {
      await py(
        ws,
        '4. GDocs: read first owned doc',
        `
import os, json
docs = sorted(os.listdir('/gdocs/owned'))[:1]
if docs:
    data = json.load(open(f'/gdocs/owned/{docs[0]}'))
    print('doc:', data.get('title') or list(data.keys())[:5])
`,
      )
    }
    if (s3 !== undefined) {
      await py(
        ws,
        '5. S3: list root, read first small object',
        `
import os
entries = sorted(os.listdir('/s3'))[:5]
print('entries:', entries)
for name in entries:
    p = f'/s3/{name}'
    if os.path.isfile(p):
        with open(p, 'rb') as f:
            data = f.read(120)
        print(f'{p}:', data[:60])
        break
`,
      )
    }

    // 6. PIL save — flagship: native lib writes to a mount.
    await py(
      ws,
      '6. PIL: save PNG to /ram, host reads bytes',
      `
from PIL import Image
img = Image.new('RGB', (4, 4), color='red')
img.save('/ram/icon.png')
print('saved /ram/icon.png')
`,
    )
    const png = await ws.fs.readFile('/ram/icon.png')
    console.log(`host sees ${String(png.length)} bytes (PNG magic: ${[...png.slice(0, 4)].map((b) => b.toString(16)).join(' ')})`)

    // 7. Cross-mount via Python: read from /linear, write to /ram.
    if (linear !== undefined) {
      await py(
        ws,
        '7. Cross-mount: Linear → RAM in one Python script',
        `
import os, json
teams = sorted(os.listdir('/linear/teams'))[:3]
out = []
for t in teams:
    p = f'/linear/teams/{t}/team.json'
    if os.path.exists(p):
        team = json.load(open(p))
        out.append({'name': team.get('name'), 'id': team.get('id')})
json.dump(out, open('/ram/summary.json', 'w'), indent=2)
print(f'wrote {len(out)} teams to /ram/summary.json')
`,
      )
      console.log('host sees:', (await ws.fs.readFileText('/ram/summary.json')).slice(0, 200))
    }
  } finally {
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
