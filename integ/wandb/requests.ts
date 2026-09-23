import { API_KEY } from '../server/wandb/store.ts'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Kind, parse, visit } from 'graphql'
import { Workspace } from '../../typescript/packages/core/src/workspace/workspace/workspace.ts'
import { getTestParser } from '../../typescript/packages/core/src/workspace/fixtures/workspace_fixture.ts'
import { WandbVFS } from '../../typescript/packages/core/src/vfs/wandb/wandb.ts'
import { normalizeWandbConfig } from '../../typescript/packages/core/src/core/wandb/config.ts'
import { MountMode } from '../../typescript/packages/core/src/types.ts'
import type { RequestRecord, startWandb } from '../server/wandb/fake.ts'

interface Step {
  command: string
  operations: string[]
  content_fields: string[]
  invalidate?: boolean
  filename?: string
  run_metadata?: boolean
}
interface Scenario {
  name: string
  steps: Step[]
}
export interface RequestResult {
  exit_code: number
  requests: RequestRecord[]
}
export const scenarios = JSON.parse(
  readFileSync(new URL('./requests.json', import.meta.url), 'utf8'),
) as Scenario[]

const runMetadataFields = [
  'id',
  'displayName',
  'state',
  'tags',
  'sweepName',
  'group',
  'jobType',
  'commit',
  'readOnly',
  'createdAt',
  'heartbeatAt',
  'description',
  'notes',
  'user',
  'username',
  'email',
  'systemMetrics',
  'historyLineCount',
  'fileCount',
]

export function checkRequests(results: RequestResult[], language: string): void {
  const steps = scenarios.flatMap((scenario) => scenario.steps)
  assert.equal(results.length, steps.length)
  for (const [i, step] of steps.entries()) {
    const result = results[i]!
    const label = `${language}: ${step.command}`
    assert.equal(result.exit_code, 0, label)
    const fields = new Set<string>()
    const operations = result.requests.map((request) => {
      const document = parse(request.query)
      visit(document, {
        Field: (node) => {
          fields.add(node.name.value)
        },
      })
      const operation = document.definitions.find((d) => d.kind === Kind.OPERATION_DEFINITION)
      if (operation?.name?.value === 'RunFile')
        assert.deepEqual(request.variables.names, [step.filename], label)
      return operation?.name?.value
    })
    assert.deepEqual(operations, step.operations, label)
    const content = [
      'config',
      'summaryMetrics',
      'historyKeys',
      'history',
      'directUrl',
      'url',
      ...runMetadataFields,
    ]
      .filter((field) => fields.has(field))
      .sort()
    const expected = [...step.content_fields, ...(step.run_metadata ? runMetadataFields : [])]
    assert.deepEqual(content, expected.sort(), label)
  }
}

export async function requestChecks(server: Awaited<ReturnType<typeof startWandb>>): Promise<void> {
  const results: RequestResult[] = []
  for (const scenario of scenarios) {
    const vfs = new WandbVFS(
      normalizeWandbConfig({
        entities: ['lab'],
        api_key: API_KEY,
        base_url: server.base,
      }),
    )
    const ws = new Workspace(
      { '/wandb': vfs },
      {
        mode: MountMode.READ,
        shellParser: await getTestParser(),
      },
    )
    try {
      for (const step of scenario.steps) {
        if (step.invalidate) await vfs.index.invalidate()
        const start = server.requests.length
        const result = await ws.shell(step.command)
        results.push({ exit_code: result.exitCode, requests: server.requests.slice(start) })
      }
    } finally {
      await ws.close()
    }
  }
  checkRequests(results, 'TypeScript')
}
