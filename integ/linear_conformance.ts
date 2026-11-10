import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LINEAR, Workspace } from '@struktoai/mirage-core'
import { LinearVFS } from '../typescript/packages/core/dist/vfs/linear/linear.js'
import { start } from './server/kit/typescript/index.ts'
import type { JsonValue } from './server/kit/typescript/types.ts'
import { linearFake } from './server/linear/fake.ts'
import type { C } from './server/linear/config.ts'

const REFERENCE_SHA = '02571d34be662e5487204841fb80bf23ed79b4f0'
const REFERENCE_VERSION = '3.1.0'
const DEC = new TextDecoder()

interface Run {
  exit: number
  stdout: string
  stderr: string
}
interface Call {
  query: string
  variables: Record<string, JsonValue>
}

function record(value: JsonValue | undefined): Record<string, JsonValue> {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value))
    throw new Error('expected record')
  return value
}

function runBinary(binary: string, args: string[], cwd: string, endpoint: string): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['issue', 'relation', ...args], {
      cwd,
      env: {
        ...process.env,
        XDG_CONFIG_HOME: join(cwd, 'config'),
        XDG_CACHE_HOME: join(cwd, 'cache'),
        LINEAR_API_KEY: 'lin_api_local_test',
        LINEAR_GRAPHQL_ENDPOINT: endpoint,
        NO_COLOR: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk
    })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
    }, 30_000)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (exit) => {
      clearTimeout(timer)
      resolve({ exit: exit ?? -1, stdout, stderr })
    })
    child.stdin.end()
  })
}

async function main(): Promise<void> {
  const binary = process.env.LINEAR_BIN
  const reference = process.env.LINEAR_REFERENCE
  assert(
    binary && reference,
    'Set LINEAR_BIN and LINEAR_REFERENCE to the pinned reference build and clean checkout',
  )
  assert.equal(
    execFileSync('git', ['-C', reference, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    REFERENCE_SHA,
  )
  assert.equal(
    execFileSync('git', ['-C', reference, 'status', '--porcelain'], { encoding: 'utf8' }).trim(),
    '',
  )
  assert.equal(
    execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim(),
    `linear ${REFERENCE_VERSION}`,
  )
  const calls: Call[] = []
  let fault: {
    field: string
    payload: JsonValue
    commit: boolean
    graphqlError: string | null
    status: 200 | 503
  } | null = null
  const fake = await start<C>({
    ...linearFake,
    routes: () =>
      linearFake.routes().map((route) => ({
        ...route,
        handler: async (ctx) => {
          const body = record(ctx.json())
          calls.push({
            query: typeof body.query === 'string' ? body.query : '',
            variables: record(body.variables),
          })
          if (
            fault !== null &&
            typeof body.query === 'string' &&
            body.query.includes(fault.field)
          ) {
            const injected = fault
            fault = null
            if (injected.commit) await route.handler(ctx)
            return injected.graphqlError
              ? { status: injected.status, body: { errors: [{ message: injected.graphqlError }] } }
              : { status: injected.status, body: { data: { [injected.field]: injected.payload } } }
          }
          return route.handler(ctx)
        },
      })),
  })
  const home = mkdtempSync(join(tmpdir(), 'linear-relations-'))
  const endpoint = `http://127.0.0.1:${fake.port}/graphql`
  const config = { apiKey: 'lin_api_local_test', baseUrl: endpoint }
  const graphql = async (
    query: string,
    variables: Record<string, JsonValue> = {},
  ): Promise<Record<string, JsonValue>> => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    })
    const body: JsonValue = await response.json()
    const envelope = record(body)
    assert.equal(envelope.errors, undefined, JSON.stringify(envelope.errors))
    return record(envelope.data)
  }
  const issueState = async (id: string): Promise<string> => {
    const issue = record(
      (
        await graphql(
          'query Issue($issueId: String!) { issue(id: $issueId) { id state { name } } }',
          { issueId: id },
        )
      ).issue,
    )
    const name = record(issue.state).name
    assert.equal(typeof name, 'string')
    return String(name)
  }
  const summaries: Record<string, unknown>[] = []
  try {
    for (const host of ['reference', 'mirage']) {
      await fake.runtime.reset({})
      const ws = new Workspace({ '/issues': new LinearVFS(config) })
      ws.registerCli('linear', LINEAR, config)
      const run = async (args: string[]): Promise<Run> => {
        calls.length = 0
        if (host === 'reference') return runBinary(binary, args, home, endpoint)
        const result = await ws.shell(
          `linear issue relation ${args.map((value) => `'${value.replaceAll("'", "'\\''")}'`).join(' ')}`,
        )
        return {
          exit: result.exitCode,
          stdout: DEC.decode(result.stdout),
          stderr: DEC.decode(result.stderr),
        }
      }
      const success = async (args: string[]): Promise<Run> => {
        const result = await run(args)
        assert.equal(result.exit, 0, `${host} ${args.join(' ')}: ${result.stderr}`)
        return result
      }
      const mutations: JsonValue[] = []
      try {
        for (const kind of ['BLOCKS', 'blocked-by', 'related', 'duplicate']) {
          const cachedPath =
            '/issues/teams/PLAT__Platform__team_plat/issues/PLAT-1__iss_plat_1/issue.json'
          if (host === 'mirage' && kind === 'duplicate') {
            const before = await ws.shell(`cat ${cachedPath}`)
            assert.equal(before.exitCode, 0, DEC.decode(before.stderr))
            assert.equal(JSON.parse(DEC.decode(before.stdout)).state_name, 'In Progress')
          }
          await success(['add', 'plat-1', kind, 'https://linear.app/example/issue/PLAT-2/title'])
          const creates = calls.filter((call) => call.query.includes('mutation '))
          assert.equal(creates.length, 1)
          assert(creates[0]?.query.includes('issueRelationCreate'))
          const expected =
            kind === 'blocked-by'
              ? { issueId: 'iss_plat_2', relatedIssueId: 'iss_plat_1', type: 'blocks' }
              : { issueId: 'iss_plat_1', relatedIssueId: 'iss_plat_2', type: kind.toLowerCase() }
          assert.deepEqual(creates[0]?.variables.input, expected)
          mutations.push(record(creates[0]?.variables.input))
          const listed = await success(['list', 'PLAT-2'])
          if (host === 'mirage') {
            const rows = JSON.parse(listed.stdout)
            assert.equal(rows.length, 1)
            assert.equal(rows[0].direction, kind === 'blocked-by' ? 'outgoing' : 'incoming')
            assert.equal(
              rows[0].type,
              kind === 'BLOCKS' ? 'blocked-by' : kind === 'blocked-by' ? 'blocks' : kind,
            )
          } else {
            assert.match(
              listed.stdout,
              new RegExp(
                kind === 'BLOCKS' ? 'blocked-by' : kind === 'blocked-by' ? 'blocks' : kind,
              ),
            )
          }
          if (kind === 'duplicate') {
            assert.equal(await issueState('iss_plat_1'), 'Duplicate')
            assert.equal(await issueState('iss_plat_2'), 'Todo')
            if (host === 'mirage') {
              const after = await ws.shell(`cat ${cachedPath}`)
              assert.equal(after.exitCode, 0, DEC.decode(after.stderr))
              assert.equal(JSON.parse(DEC.decode(after.stdout)).state_name, 'Duplicate')
            }
          }
          const unconfirmed = await run(['delete', 'PLAT-1', kind, 'PLAT-2'])
          assert.equal(unconfirmed.exit, host === 'reference' ? 2 : 1)
          assert(calls.every((call) => !call.query.includes('mutation ')))
          await success(['delete', 'PLAT-1', kind, 'PLAT-2', '--yes'])
          assert.equal(calls.filter((call) => call.query.includes('issueRelationDelete')).length, 1)
          assert.equal(await issueState('iss_plat_1'), 'In Progress')
          if (host === 'mirage' && kind === 'duplicate') {
            const restored = await ws.shell(`cat ${cachedPath}`)
            assert.equal(restored.exitCode, 0, DEC.decode(restored.stderr))
            assert.equal(JSON.parse(DEC.decode(restored.stdout)).state_name, 'In Progress')
          }
        }
        for (const args of [
          ['add', 'PLAT-1', 'blocks', 'PLAT-0'],
          ['add', 'PLAT-1', 'blocks', 'https://linear.app../example/issue/PLAT-2'],
        ]) {
          const result = await run(args)
          assert.notEqual(result.exit, 0)
          assert.equal(calls.length, 0, `${host}: invalid operands made requests`)
        }
        for (const { args, virtualExit } of [
          { args: ['add', 'PLAT-1', 'similar', 'PLAT-2'], virtualExit: 1 },
          { args: ['add', 'PLAT-1', 'blocks'], virtualExit: 2 },
          { args: ['add', 'PLAT-1', 'blocks', 'PLAT-2', 'extra'], virtualExit: 1 },
          { args: ['add', 'PLAT-1', 'blocks', 'PLAT-2', '--invalid'], virtualExit: 2 },
        ]) {
          const result = await run(args)
          assert.equal(
            result.exit,
            host === 'reference' ? 2 : virtualExit,
            `${host}: ${args.join(' ')}`,
          )
          assert.equal(calls.length, 0)
        }
        fault = {
          field: 'issue(id:',
          payload: null,
          commit: false,
          graphqlError: 'Entity not found: Issue',
          status: 200,
        }
        const notFound = await run(['add', 'PLAT-1', 'blocks', 'PLAT-2'])
        assert.equal(notFound.exit, host === 'reference' ? 3 : 1)
        assert(calls.every((call) => !call.query.includes('mutation ')))
        for (const reference of [
          'https://linear.app:443/example/issue/PLAT-1',
          'http://linear.app:80/example/issue/PLAT-1',
          'https://linear.app/example/x/../issue/PLAT-1',
          'https://linear.app/example/x/%2e%2e/issue/PLAT-1',
        ]) {
          await success(['add', reference, 'related', 'PLAT-2'])
          await success(['delete', 'PLAT-1', 'related', 'PLAT-2', '--yes'])
        }
        for (const alias of ['-y', '-f', '--force', '--confirm']) {
          await success(['add', 'PLAT-1', 'related', 'PLAT-2'])
          await success(['delete', 'PLAT-1', 'related', 'PLAT-2', alias])
        }
        await success(['add', 'PLAT-1', 'related', 'PLAT-2'])
        const reversed = await run(['delete', 'PLAT-2', 'related', 'PLAT-1', '--yes'])
        assert.equal(reversed.exit, host === 'reference' ? 3 : 1)
        assert(calls.every((call) => !call.query.includes('mutation ')))
        await success(['delete', 'PLAT-1', 'related', 'PLAT-2', '--yes'])
        const absent = await run(['add', 'PLAT-1', 'blocks', 'PLAT-9999'])
        assert.equal(absent.exit, 1)
        assert(calls.every((call) => !call.query.includes('mutation ')))
        for (let n = 0; n < 101; n += 1) {
          const created = await graphql(
            'mutation IssueCreate($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier } } }',
            { input: { teamId: 'team_plat', title: `Page ${n}` } },
          )
          const issue = record(record(created.issueCreate).issue)
          for (const [source, target] of [
            ['iss_plat_1', issue.id],
            [issue.id, 'iss_plat_1'],
          ]) {
            assert(typeof source === 'string' && typeof target === 'string')
            await graphql(
              'mutation CreateIssueRelation($input: IssueRelationCreateInput!) { issueRelationCreate(input: $input) { success } }',
              { input: { issueId: source, relatedIssueId: target, type: 'blocks' } },
            )
          }
        }
        const paged = await success(['list', 'PLAT-1'])
        if (host === 'mirage') assert.equal(JSON.parse(paged.stdout).length, 202)
        else
          assert.equal(
            paged.stdout
              .split('\n')
              .filter((line) => /^ {2}PLAT-1 (?:blocks|blocked-by) /.test(line)).length,
            202,
          )
        assert(
          calls.filter(
            (call) => call.variables.after !== null && call.variables.after !== undefined,
          ).length >= 2,
        )
        await success(['delete', 'PLAT-1', 'blocks', 'PLAT-103', '--yes'])
        assert(
          calls.some((call) => call.variables.after !== null && call.variables.after !== undefined),
        )
        for (const payload of [{ success: false }, {}]) {
          fault = {
            field: 'issueRelationCreate',
            payload,
            commit: false,
            graphqlError: null,
            status: 200,
          }
          const failed = await run(['add', 'PLAT-1', 'related', 'PLAT-2'])
          assert.equal(failed.exit, 1)
          assert.equal(calls.filter((call) => call.query.includes('mutation ')).length, 1)
        }
        fault = {
          field: 'issueRelationCreate',
          payload: null,
          commit: false,
          graphqlError: 'local injected GraphQL failure',
          status: 200,
        }
        const graphqlFailure = await run(['add', 'PLAT-1', 'related', 'PLAT-2'])
        assert.equal(graphqlFailure.exit, 1)
        assert.equal(calls.filter((call) => call.query.includes('mutation ')).length, 1)
        fault = {
          field: 'issueRelationCreate',
          payload: {},
          commit: true,
          graphqlError: null,
          status: 200,
        }
        const uncertain = await run(['add', 'PLAT-1', 'related', 'PLAT-2'])
        assert.equal(uncertain.exit, 1)
        assert.equal(calls.filter((call) => call.query.includes('mutation ')).length, 1)
        for (const payload of [{ success: false }, {}]) {
          fault = {
            field: 'issueRelationDelete',
            payload,
            commit: false,
            graphqlError: null,
            status: 200,
          }
          const failed = await run(['delete', 'PLAT-1', 'related', 'PLAT-2', '--yes'])
          assert.equal(failed.exit, 1)
          assert.equal(calls.filter((call) => call.query.includes('mutation ')).length, 1)
        }
        await success(['delete', 'PLAT-1', 'related', 'PLAT-2', '--yes'])
        for (const operation of ['create', 'delete']) {
          if (operation === 'delete') await success(['add', 'PLAT-1', 'related', 'PLAT-2'])
          fault = {
            field: operation === 'create' ? 'issueRelationCreate' : 'issueRelationDelete',
            payload: null,
            commit: true,
            graphqlError: 'local reply failure after commit',
            status: 503,
          }
          const result = await run(
            operation === 'create'
              ? ['add', 'PLAT-1', 'related', 'PLAT-2']
              : ['delete', 'PLAT-1', 'related', 'PLAT-2', '--yes'],
          )
          assert.equal(result.exit, host === 'reference' ? 5 : 1)
          assert.equal(calls.filter((call) => call.query.includes('mutation ')).length, 1)
          if (host === 'mirage')
            assert.match(result.stderr, /outcome is unknown.*check relations before retrying/)
          if (operation === 'create')
            await success(['delete', 'PLAT-1', 'related', 'PLAT-2', '--yes'])
          const listed = await success(['list', 'PLAT-1'])
          if (host === 'mirage')
            assert(
              JSON.parse(listed.stdout).every((row: { type: string }) => row.type !== 'related'),
            )
          else assert.doesNotMatch(listed.stdout, /PLAT-1 related /)
        }
        summaries.push({ host, mutations })
      } finally {
        await ws.close()
      }
    }
    assert.deepEqual(summaries[0]?.mutations, summaries[1]?.mutations)
    const denied = new Workspace(
      {},
      {
        policies: [
          { preCommand: (ctx) => (ctx.write ? { kind: 'deny', reason: 'read only' } : null) },
        ],
      },
    )
    denied.registerCli('linear', LINEAR, config)
    try {
      calls.length = 0
      const result = await denied.shell('linear issue relation add PLAT-1 duplicate PLAT-2')
      assert.notEqual(result.exitCode, 0)
      assert.equal(calls.length, 0)
      assert.equal(result.decision?.reason, 'read only')
    } finally {
      await denied.close()
    }
    console.log(
      `Linear ${REFERENCE_VERSION} relation conformance passed against ${REFERENCE_SHA}; duplicate relation/state, restoration, pagination, policy and cache rereads verified locally.`,
    )
  } finally {
    await fake.close()
    rmSync(home, { recursive: true, force: true })
  }
}

await main()
