import { checkSchema } from './schema.ts'
import { API_KEY } from '../server/wandb/store.ts'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Workspace } from '../../typescript/packages/core/src/workspace/workspace/workspace.ts'
import { getTestParser } from '../../typescript/packages/core/src/workspace/fixtures/workspace_fixture.ts'
import { WandbVFS } from '../../typescript/packages/core/src/vfs/wandb/wandb.ts'
import { normalizeWandbConfig } from '../../typescript/packages/core/src/core/wandb/config.ts'
import { MountMode, PathSpec } from '../../typescript/packages/core/src/types.ts'
import { readStream } from '../../typescript/packages/core/src/core/wandb/read.ts'
import { selftest } from '../server/wandb/selftest.ts'
import { startWandb } from '../server/wandb/fake.ts'
import { checkRequests, requestChecks, type RequestResult } from './requests.ts'

interface Result {
  name: string
  stdout: string
  stderr?: string
  exit_code: number
}
interface Case extends Result {
  command: string
}
interface PythonResult {
  cases: Result[]
  requests: RequestResult[]
}
function python(base: string): Promise<PythonResult> {
  const pythonDir = fileURLToPath(new URL('../../python', import.meta.url))
  const executable = process.env.MIRAGE_PYTHON ?? pythonDir + '/.venv/bin/python'
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [fileURLToPath(new URL('./python.py', import.meta.url))], {
      cwd: pythonDir,
      env: { ...process.env, PYTHONPATH: pythonDir, WANDB_BASE_URL: base, WANDB_API_KEY: API_KEY },
    })
    let stdout = '',
      stderr = ''
    child.stdout.on('data', (b: Buffer) => {
      stdout += b.toString()
    })
    child.stderr.on('data', (b: Buffer) => {
      stderr += b.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(stderr))
      else {
        try {
          resolve(JSON.parse(stdout) as PythonResult)
        } catch (error) {
          reject(error)
        }
      }
    })
  })
}

checkSchema()
await selftest()
const server = await startWandb()
const vfs = new WandbVFS(
  normalizeWandbConfig({
    entities: ['lab', 'other'],
    api_key: API_KEY,
    base_url: server.base,
    page_size: 2,
  }),
)
const ws = new Workspace(
  { '/wandb': vfs },
  { mode: MountMode.READ, shellParser: await getTestParser() },
)
const decoder = new TextDecoder()
try {
  const cases = JSON.parse(readFileSync(new URL('./cases.json', import.meta.url), 'utf8')) as Case[]
  const ts: Result[] = []
  for (const c of cases) {
    const result = await ws.shell(c.command)
    ts.push({
      name: c.name,
      stdout: decoder.decode(result.stdout),
      stderr: decoder.decode(result.stderr),
      exit_code: result.exitCode,
    })
  }
  const py = await python(server.base)
  checkRequests(py.requests, 'Python')
  await requestChecks(server)
  for (const [i, c] of cases.entries()) {
    const expected = { name: c.name, stdout: c.stdout, stderr: '', exit_code: c.exit_code }
    assert.deepEqual(ts[i], expected, `TypeScript: ${c.name}`)
    assert.deepEqual(py.cases[i], expected, `Python: ${c.name}`)
  }
  const p = (key: string) => PathSpec.fromStrPath('/wandb/' + key, key)
  const summary = 'lab/experiments/run-a/summary.json'
  const other = 'other/experiments/run-a/summary.json'
  const values = await Promise.all([vfs.readFile(p(summary)), vfs.readFile(p(other))])
  assert.deepEqual(
    values.map((b) => JSON.parse(decoder.decode(b))),
    [{ score: 0.4 }, { score: 42 }],
  )
  assert.deepEqual(
    JSON.parse(decoder.decode(await vfs.readFile(p('lab/experiments/run-a/config.json')))),
    { lr: 0.01, label: 'café' },
  )
  assert.equal((await vfs.stat(p(summary))).size, null)
  for (const page_size of [1, 5]) {
    const narrow = new WandbVFS(
      normalizeWandbConfig({
        entities: ['lab'],
        api_key: API_KEY,
        base_url: server.base,
        page_size,
      }),
    )
    try {
      const data = decoder.decode(await narrow.readFile(p('lab/experiments/run-a/history.jsonl')))
      const steps = data
        .trim()
        .split('\n')
        .map((line) => (JSON.parse(line) as { _step: number })._step)
      assert.deepEqual(
        steps,
        [0, 1, 4, 5],
        `single-step history window with page_size=${page_size}`,
      )
    } finally {
      await narrow.close()
    }
  }
  assert.equal((await vfs.stat(p('lab/experiments/run-a/files/notes.txt'))).size, 6)
  assert.deepEqual(
    [...(await vfs.readFile(p('lab/experiments/run-a/files/nested/model.bin')))],
    [0, 1, 2, 255],
  )
  assert(!JSON.stringify(await vfs.getState()).includes(API_KEY))
  const unauth = new WandbVFS(
    normalizeWandbConfig({ entities: ['lab'], api_key: 'invalid', base_url: server.base }),
  )
  await assert.rejects(unauth.accessor.client.projects('lab'), { code: 'EACCES' })
  const path = PathSpec.fromStrPath(
    '/wandb/lab/experiments/run-long/history.jsonl',
    'lab/experiments/run-long/history.jsonl',
  )
  const start = server.requests.length
  const stream = readStream(vfs.accessor, path, vfs.index)
  assert.equal((await stream.next()).done, false)
  await stream.return(undefined)
  assert.equal(
    server.requests.slice(start).filter((r) => r.query.includes('query HistoryPage')).length,
    1,
    'prefix stream fetched more than one history page',
  )
  assert(
    server.requests.some((r) => r.variables.cursor === 'cursor:2'),
    'pagination never advanced',
  )
  const history = server.requests.filter((r) => r.query.includes('query HistoryPage'))
  assert(
    history.some((r) => r.variables.minStep === 2),
    'empty history window was not queried',
  )
  assert(
    history.some((r) => r.variables.minStep === 4),
    'scan stopped at an empty history window',
  )
  for (const command of [
    'cat /wandb/lab/experiments/run-a',
    'cat /wandb/lab/experiments/run-a/files/nested',
    'cat /wandb/lab/experiments/run-a/summary.json/child',
    'cat /wandb/lab/experiments/nope/history.jsonl',
    'cat /wandb/lab/experiments/nope/run.json',
    'cat /wandb/nope',
    'cat /wandb/lab/experiments/run-a/files/nope',
    'echo bad > /wandb/lab/experiments/run-a/summary.json',
  ]) {
    assert.notEqual((await ws.shell(command)).exitCode, 0, command)
  }
  console.log(
    `W&B integration: ${cases.length} shared cases passed in Python and TypeScript; request budgets, pagination, streaming and refusal checks passed`,
  )
} finally {
  await ws.close()
  await server.close()
}
