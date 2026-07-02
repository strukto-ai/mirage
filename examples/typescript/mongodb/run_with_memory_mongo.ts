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

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { MongoClient, ObjectId } from 'mongodb'

const here = dirname(fileURLToPath(import.meta.url))
const tsx = resolve(here, '..', '..', '..', 'typescript', 'node_modules', '.bin', 'tsx')

async function seed(uri: string): Promise<void> {
  const client = new MongoClient(uri)
  await client.connect()
  try {
    const db = client.db('app')
    await db.collection('users').insertMany([
      {
        _id: new ObjectId('507f1f77bcf86cd799439011'),
        name: 'alice',
        email: 'alice@example.com',
        created_at: new Date('2026-04-01T00:00:00Z'),
        active: true,
      },
      {
        _id: new ObjectId('507f1f77bcf86cd799439012'),
        name: 'bob',
        email: 'bob@example.com',
        created_at: new Date('2026-04-02T00:00:00Z'),
        active: true,
      },
      {
        _id: new ObjectId('507f1f77bcf86cd799439013'),
        name: 'carol',
        email: null,
        created_at: new Date('2026-04-03T00:00:00Z'),
        active: false,
      },
    ])
    await db.collection('events').insertMany([
      { kind: 'login', user: 'alice', at: new Date('2026-04-15T10:00:00Z') },
      { kind: 'logout', user: 'alice', at: new Date('2026-04-15T11:00:00Z') },
      { kind: 'login', user: 'bob', at: new Date('2026-04-15T12:00:00Z') },
    ])
    const analytics = client.db('analytics')
    await analytics.collection('pageviews').insertMany([
      { path: '/', count: 1234 },
      { path: '/about', count: 56 },
      { path: '/pricing', count: 789 },
    ])
  } finally {
    await client.close()
  }
}

async function runExample(file: string, uri: string): Promise<number> {
  const examplePath = resolve(here, file)
  return new Promise<number>((resolveExit) => {
    const child = spawn(tsx, [examplePath], {
      stdio: 'inherit',
      env: { ...process.env, MONGODB_URI: uri },
      cwd: resolve(here, '..', '..', '..'),
    })
    child.on('exit', (code) => resolveExit(code ?? 0))
  })
}

async function main(): Promise<void> {
  console.log('Booting in-process MongoDB…')
  const server = await MongoMemoryServer.create()
  const uri = server.getUri()
  console.log(`Mongo at ${uri}\n`)
  try {
    await seed(uri)

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log('  Direct probe: BSON serialization (Date + ObjectId + null)')
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    {
      const { MongoDBResource, MountMode, Workspace, PathSpec } = await import('@struktoai/mirage-node')
      const resource = new MongoDBResource({ uri })
      const ws = new Workspace({ '/m/': resource }, { mode: MountMode.READ })
      const DEC = new TextDecoder()
      try {
        const ps = (p: string) => PathSpec.fromStrPath(p)
        const usersBytes = await resource.readFile(ps('/app/users.jsonl'))
        const usersText = DEC.decode(usersBytes).trim().split('\n')
        console.log('app/users.jsonl:')
        for (const line of usersText) console.log(`  ${line}`)

        const grepRes = await ws.execute('grep alice /m/app/users.jsonl')
        console.log('\ngrep alice:', DEC.decode(grepRes.stdout).trim())

        const eventsRes = await ws.execute('grep login /m/app/events.jsonl')
        console.log('grep login (events):')
        for (const line of DEC.decode(eventsRes.stdout).trim().split('\n')) {
          console.log(`  ${line}`)
        }
      } finally {
        await ws.close()
        await resource.close()
      }
    }

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log('  examples/typescript/mongodb/mongodb.ts')
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    const code1 = await runExample('mongodb.ts', uri)
    console.log(`\n  exit=${String(code1)}`)

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log('  examples/typescript/mongodb/mongodb_vfs.ts')
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    const code2 = await runExample('mongodb_vfs.ts', uri)
    console.log(`\n  exit=${String(code2)}`)
  } finally {
    await server.stop()
    console.log('\nIn-process MongoDB stopped.')
  }
}

await main()
