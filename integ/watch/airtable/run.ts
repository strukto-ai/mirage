import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { AirtableVFS, PathSpec, Workspace } from '@struktoai/mirage-node'

const SPECIFICATION = { options: { filters: { dataTypes: ['tableData'] } } }

interface Write {
  method: string
  path: string
  body?: unknown
}

interface Case {
  id: string
  root: string
  writes: Write[]
  expect: [string, string][]
}

interface Spec {
  mount: string
  base: string
  token: string
  cases: Case[]
}

async function call(url: string, token: string, method: string, body?: unknown): Promise<void> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const r = await fetch(url, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!r.ok) throw new Error(`${method} ${url} answered ${String(r.status)} ${await r.text()}`)
}

async function runCase(origin: string, spec: Spec, item: Case): Promise<void> {
  const run = `watch-typescript-${item.id}`
  const baseUrl = `${origin}/_run/${run}/v0`
  const virtual = item.root !== '' ? `${spec.mount}/${item.root}` : spec.mount
  const root = PathSpec.fromStrPath(virtual, item.root)
  const vfs = new AirtableVFS({ token: spec.token, baseUrl, requestsPerSecond: 100 })
  const ws = new Workspace({ [spec.mount]: vfs })
  const hook = vfs.deltaHook()
  try {
    await call(`${origin}/_run/${run}/reset`, spec.token, 'POST', {})
    await call(`${baseUrl}/bases/${spec.base}/webhooks`, spec.token, 'POST', {
      specification: SPECIFICATION,
    })
    const baseline = await hook.pull(root, null)
    assert.deepEqual(baseline.changes, [])
    for (const write of item.writes) {
      await call(`${baseUrl}/${write.path}`, spec.token, write.method, write.body)
    }
    const delta = await hook.pull(root, baseline.checkpoint)
    const got = delta.changes.map((c) => [c.kind, c.path.virtual])
    assert.deepEqual(got, item.expect, item.id)
    for (const [kind, path] of got) {
      if (kind === 'delete') continue
      const served = await ws.shell(`ls -d ${String(path)}`)
      assert.equal(served.exitCode, 0, `${item.id} ${String(path)}`)
    }
    const again = await hook.pull(root, delta.checkpoint)
    assert.deepEqual(again.changes, [], item.id)
    console.log(`PASS typescript airtable ${item.id}`)
  } finally {
    await ws.close()
  }
}

const origin = process.env.AIRTABLE_URL
if (origin === undefined || origin === '') {
  console.log('SKIP typescript airtable: AIRTABLE_URL is unset')
} else {
  const spec = JSON.parse(await readFile(new URL('./cases.json', import.meta.url), 'utf8')) as Spec
  for (const item of spec.cases) await runCase(origin.replace(/\/+$/, ''), spec, item)
}
