import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import type { startMounts } from './mounts.ts'

const mountFixtures = process.argv.includes('--mounts') ? await import('./mounts.ts') : undefined

type Host = 'python' | 'typescript'
interface Case {
  id: string
  command: string
  finish: 'release' | 'cancel'
  gate?: 'slack' | 'file'
  parent_cwd?: string
  stdout?: string
}
interface Job {
  jobId: string
  workspaceId: string
  command: string
  status: string
  sessionId: string
  revision: number
  cancelRequested: boolean
  submittedAt: number
  startedAt: number | null
  finishedAt: number | null
  result?: Result | null
  error?: string | null
}
interface Result {
  stdout: string
  stderr: string
  exitCode: number
  refusal: { kind: string; reason: string; askId: string | null } | null
}
interface TrackingCase {
  id: string
  command: string
  profile?: string
  record?: boolean
  expect: {
    stdout: string
    stderr: string
    exit_code: number
    refusal: { kind: string; reason: string } | null
  }
}
interface Session {
  sessionId: string
  cwd: string
}
const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const cases = JSON.parse(await readFile(join(here, 'cases.json'), 'utf8')) as Case[]
const montyCases = JSON.parse(await readFile(join(here, 'monty.json'), 'utf8')) as Case[]
const trackingCases = JSON.parse(
  await readFile(join(here, 'tracking.json'), 'utf8'),
) as TrackingCase[]

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
      normalize(item),
    ]),
  )
}

async function poll<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 10_000
  do {
    const value = await read()
    if (value !== undefined) return value
    await delay(10)
  } while (Date.now() < deadline)
  throw new Error('condition did not become true')
}

async function run(
  host: Host,
  mounts: Awaited<ReturnType<typeof startMounts>> | undefined,
): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), `mirage-hosting-${host}-`))
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('MIRAGE_')),
  )
  Object.assign(env, { MIRAGE_HOME: home, PYTHONPATH: join(root, 'python') })
  const child =
    host === 'python'
      ? spawn(
          process.env.PYTHON ?? join(root, 'python/.venv/bin/python'),
          [join(here, 'host.py')],
          { env, cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
        )
      : spawn(process.execPath, ['--import', 'tsx', join(here, 'host.ts')], {
          env,
          cwd: resolve(here, '..'),
          stdio: ['ignore', 'pipe', 'pipe'],
        })
  const exited = once(child, 'exit')
  let errors = ''
  let output = ''
  child.stdout.setEncoding('utf8').on('data', (text: string) => {
    output += text
  })
  child.stderr.setEncoding('utf8').on('data', (text: string) => {
    errors += text
  })
  const lines = createInterface({ input: child.stdout })
  const startup = setTimeout(() => child.kill('SIGKILL'), 30_000)
  try {
    let base: string | undefined
    for await (const line of lines) {
      if (line.startsWith('READY ')) {
        base = line.slice(6)
        break
      }
    }
    clearTimeout(startup)
    assert(base, `server did not start: ${errors}`)
    const url = base

    async function request<T>(
      method: string,
      path: string,
      body?: Record<string, unknown>,
      expected = 200,
    ): Promise<T> {
      const payload =
        body === undefined
          ? undefined
          : Object.fromEntries(
              Object.entries(body).map(([key, value]) => [
                key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
                value,
              ]),
            )
      const response = await fetch(url + path, {
        method,
        ...(payload === undefined
          ? {}
          : { body: JSON.stringify(payload), headers: { 'content-type': 'application/json' } }),
        signal: AbortSignal.timeout(10_000),
      })
      const result: unknown = await response.json()
      assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(result)}`)
      return normalize(result) as T
    }

    async function sessionCwd(workspaceId: string, sessionId: string): Promise<string | undefined> {
      const sessions = await request<Session[]>('GET', `/v1/workspaces/${workspaceId}/sessions`)
      return sessions.find((session) => session.sessionId === sessionId)?.cwd
    }

    for (const wid of ['a', 'b']) {
      await request(
        'POST',
        '/v1/workspaces',
        {
          id: wid,
          config: {
            mode: 'write',
            mounts: { '/work': { vfs: 'ram', mode: 'write' } },
            runtimes: [],
          },
        },
        201,
      )
      await request('POST', `/v1/workspaces/${wid}/shell`, { command: 'true' })
    }
    await request('POST', '/v1/workspaces/a/sessions', { sessionId: 'other' }, 201)

    for (const scenario of trackingCases) {
      for (const background of [false, true]) {
        const wid = `tracking-${scenario.id}-${background ? 'background' : 'foreground'}`
        const path = `/v1/workspaces/${wid}`
        await request(
          'POST',
          '/v1/workspaces',
          {
            id: wid,
            config: {
              mode: 'write',
              mounts: { '/work': { vfs: 'ram', mode: 'write' } },
              runtimes: [],
              profiles: {
                denied: { commands: { deny: [{ commands: ['rm'], reason: 'no deletes' }] } },
                approval: { commands: { ask: [{ commands: ['rm'], reason: 'needs approval' }] } },
              },
            },
          },
          201,
        )
        try {
          await request('POST', `${path}/shell`, {
            command: 'echo kept > /work/keep',
            record: false,
          })
          await request(
            'POST',
            `${path}/sessions`,
            {
              sessionId: 'agent',
              ...(scenario.profile === undefined ? {} : { profile: scenario.profile }),
            },
            201,
          )
          const shell = `${path}/shell?session_id=agent&background=${background}`
          const submitted = await request<Job | Result>(
            'POST',
            shell,
            {
              command: scenario.command,
              record: scenario.record ?? true,
            },
            background ? 202 : 200,
          )
          const listing = await request<Job[]>('GET', `/v1/jobs?workspace_id=${wid}`)
          const matching = listing.filter((job) => job.sessionId === 'agent')
          assert.equal(matching.length, 1)
          const listed = matching[0]!
          assert.equal(listed.command, scenario.command)
          assert.equal(Object.hasOwn(listed, 'result'), false, 'job lists omit result payloads')
          if ('jobId' in submitted) assert.equal(listed.jobId, submitted.jobId)
          const jobPath = `/v1/jobs/${listed.jobId}`
          const done = await request<Job>('POST', `${jobPath}/wait`, {})
          assert.equal(done.workspaceId, wid)
          assert.equal(done.sessionId, 'agent')
          assert.equal(
            done.status,
            'done',
            'a shell refusal or nonzero exit is a completed execution',
          )
          assert.equal(done.error, null)
          assert.equal(done.cancelRequested, false)
          assert(done.revision > 0)
          assert(done.startedAt !== null && done.finishedAt !== null)
          assert(done.submittedAt <= done.startedAt && done.startedAt <= done.finishedAt)
          assert(done.result)
          const result = done.result
          assert.deepEqual(
            {
              exit_code: result.exitCode,
              stdout: result.stdout,
              stderr: result.stderr,
              refusal:
                result.refusal === null
                  ? null
                  : {
                      kind: result.refusal.kind,
                      reason: result.refusal.reason,
                    },
            },
            scenario.expect,
          )
          if (!background) assert.deepEqual(result, submitted)
          assert.deepEqual(await request('GET', jobPath), done)
          assert.equal((await request<{ canceled: boolean }>('DELETE', jobPath)).canceled, false)

          if (scenario.profile !== undefined) {
            const kept = await request<Result>('POST', `${path}/shell`, {
              command: 'cat /work/keep',
              record: false,
            })
            assert.equal(
              kept.stdout,
              'kept\n',
              'refused execution must leave the backend unchanged',
            )
          }
          let attempts = 1
          if (result.refusal?.kind === 'pending') {
            const asks = await request<{ id: string; sessionId: string }[]>('GET', `${path}/asks`)
            assert.equal(asks.length, 1)
            assert.equal(asks[0]!.id, result.refusal.askId)
            assert.equal(asks[0]!.sessionId, 'agent')
            await request('POST', `${path}/asks/${result.refusal.askId}`, { answer: 'allow' })
            const retry = await request<Job>(
              'POST',
              `${path}/shell?session_id=agent&background=true`,
              {
                command: scenario.command,
              },
              202,
            )
            assert.notEqual(retry.jobId, done.jobId)
            const allowed = await request<Job>('POST', `/v1/jobs/${retry.jobId}/wait`, {})
            assert.equal(allowed.status, 'done')
            assert.equal(allowed.result?.exitCode, 0)
            assert.equal(allowed.result.refusal, null)
            assert.deepEqual(await request('GET', `${path}/asks`), [])
            const removed = await request<Result>('POST', `${path}/shell`, {
              command: 'test ! -e /work/keep',
              record: false,
            })
            assert.equal(removed.exitCode, 0)
            attempts++
          }
          const history = await request<Result>('POST', `${path}/shell?session_id=agent`, {
            command: 'cat /.bash_history',
            record: false,
          })
          assert.equal(history.exitCode, 0)
          assert.equal(
            history.stdout.replace(/^#\d+\n/gm, ''),
            scenario.record === false ? '' : `${scenario.command}\n`.repeat(attempts),
          )
          assert.deepEqual(
            await request('GET', jobPath),
            done,
            'later activity cannot rewrite a completed execution',
          )
          console.log(
            `ok ${host}/${wid}: stored result, policy outcome, observer history, immutable completion`,
          )
        } finally {
          await request('DELETE', path)
        }
      }
    }

    for (const scenario of [...cases, ...(mounts === undefined ? [] : montyCases)]) {
      const mounted = scenario.gate !== undefined
      const a = mounted ? `${host}-${scenario.id}-a` : 'a'
      const b = mounted ? `${host}-${scenario.id}-b` : 'b'
      if (mounted) {
        assert(mounts)
        for (const wid of [a, b]) {
          await request('POST', '/v1/workspaces', { id: wid, config: mounts.config(wid) }, 201)
          await request('POST', `/v1/workspaces/${wid}/sessions`, { sessionId: 'other' }, 201)
          const seeded: Result = await request<Result>('POST', `/v1/workspaces/${wid}/shell`, {
            command: mounts.seed(wid),
          })
          assert.equal(seeded.exitCode, 0, JSON.stringify(seeded))
          assert.match(seeded.stdout, /monty/)
        }
      }
      const gate = scenario.gate === 'slack' ? mounts?.arm(a) : undefined
      const path = `/v1/workspaces/${a}/shell`
      const command = `${scenario.command.replace('{url}', `${url}/__integ/hold/${scenario.id}`)} && echo done > /work/${scenario.id}-tail`
      let settled = false
      const foreground = request<Result>(
        'POST',
        path,
        { command },
        scenario.finish === 'cancel' ? 499 : 200,
      ).finally(() => {
        settled = true
      })
      // Attach a rejection observer immediately; the assertion below still awaits the original promise.
      void foreground.catch((error: unknown) => {
        console.error('foreground request failed', error)
      })
      try {
        const running = await poll(async () => {
          if (settled)
            assert.fail(
              `${scenario.id} finished before admission: ${JSON.stringify(await foreground)}`,
            )
          const jobs = await request<Job[]>('GET', '/v1/jobs')
          return jobs.find((job) => job.command === command && job.status === 'running')
        })
        if (gate !== undefined) {
          await poll(async () => {
            if (settled)
              assert.fail(
                `${scenario.id} finished before its mount read: ${JSON.stringify(await foreground)}`,
              )
            return gate.entered ? true : undefined
          })
        } else if (scenario.gate === 'file') {
          await poll(async () =>
            (
              await request<Result>('POST', `${path}?session_id=other`, {
                command: 'test -e /work/started',
              })
            ).exitCode === 0
              ? true
              : undefined,
          )
        } else if (scenario.id !== 'shell_loop') {
          await poll(async () =>
            (await request<{ entered: boolean }>('GET', `/__integ/entered/${scenario.id}`)).entered
              ? true
              : undefined,
          )
        }
        if (scenario.parent_cwd !== undefined) {
          assert.equal(
            await sessionCwd(a, running.sessionId),
            scenario.parent_cwd,
            'a suspended substitution must not change its parent session',
          )
          assert.equal(settled, false, 'the substitution must still be held at its HTTP read')
        }
        const queued = await Promise.all(
          ['discard', 'keep'].map((tag) =>
            request<Job>(
              'POST',
              `${path}?background=true`,
              {
                command: `echo ${tag} > /work/${scenario.id}-${tag}`,
              },
              202,
            ),
          ),
        )
        const [discard, keep] = queued
        assert(discard && keep)
        for (const submitted of queued) {
          const job = await request<Job>('GET', `/v1/jobs/${submitted.jobId}`)
          assert.equal(job.status, 'pending')
          assert.equal(job.sessionId, running.sessionId)
          assert.equal(job.startedAt, null)
        }
        const [sameWorkspace, otherWorkspace, health] = await Promise.all([
          request<Result>('POST', `${path}?session_id=other`, {
            command: mounted ? 'python3 /work/probe.py other' : 'echo same-workspace',
          }),
          request<Result>('POST', `/v1/workspaces/${b}/shell`, {
            command: mounted ? 'python3 /work/probe.py default' : 'echo other-workspace',
          }),
          request<{ status: string }>('GET', '/v1/health'),
        ])
        assert.equal(sameWorkspace.exitCode, 0, JSON.stringify(sameWorkspace))
        assert.equal(otherWorkspace.exitCode, 0, JSON.stringify(otherWorkspace))
        assert.equal(
          sameWorkspace.stdout,
          mounted ? `${a}:other:ram,s3,redis,slack\n` : 'same-workspace\n',
        )
        assert.equal(
          otherWorkspace.stdout,
          mounted ? `${b}:default:ram,s3,redis,slack\n` : 'other-workspace\n',
        )
        assert.equal(health.status, 'ok')
        assert.equal(
          settled,
          false,
          'the independent requests must finish while the first is still active',
        )
        await request('DELETE', `/v1/jobs/${discard.jobId}`)
        const canceled = await request<Job>('POST', `/v1/jobs/${discard.jobId}/wait`, {})
        assert.equal(canceled.status, 'canceled')
        assert.equal(canceled.startedAt, null)
        if (scenario.finish === 'cancel') await request('DELETE', `/v1/jobs/${running.jobId}`)
        else if (gate !== undefined) gate.release()
        else await request('POST', `/__integ/release/${scenario.id}`, {})
        const completed = await foreground
        if (scenario.finish === 'release')
          assert.equal(completed.exitCode, 0, JSON.stringify(completed))
        if (scenario.stdout !== undefined) assert.equal(completed.stdout, scenario.stdout)
        if (scenario.parent_cwd !== undefined) {
          assert.equal(
            await sessionCwd(a, running.sessionId),
            scenario.parent_cwd,
            'the parent session must remain unchanged after completion or cancellation',
          )
        }
        assert.equal((await request<Job>('POST', `/v1/jobs/${keep.jobId}/wait`, {})).status, 'done')
        const tail = scenario.finish === 'cancel' ? '! -e' : '-e'
        const check = await request<Result>('POST', path, {
          command: `test ! -e /work/${scenario.id}-discard && test ${tail} /work/${scenario.id}-tail && cat /work/${scenario.id}-keep`,
        })
        assert.equal(check.exitCode, 0)
        assert.equal(check.stdout, 'keep\n')
        if (mounted) {
          const recovered = await request<Result>('POST', path, {
            command: 'python3 /work/probe.py recovered',
          })
          assert.equal(recovered.exitCode, 0, JSON.stringify(recovered))
          assert.equal(recovered.stdout, `${a}:recovered:ram,s3,redis,slack\n`)
          const isolated = await request<Result>('POST', `/v1/workspaces/${b}/shell`, {
            command:
              'test ! -e /work/probe-other.txt && test ! -e /s3/probe-other.txt && test ! -e /redis/probe-other.txt',
          })
          assert.equal(isolated.exitCode, 0, JSON.stringify(isolated))
        }
        console.log(
          `ok ${host}/${scenario.id}: same-session queue, independent requests, ${scenario.finish}, no canceled writes${scenario.parent_cwd !== undefined ? ', parent isolated during and after await' : ''}${mounted ? ', Monty + RAM/S3/Redis/Slack + recovery + isolation' : ''}`,
        )
      } finally {
        gate?.release()
        await request('POST', `/__integ/release/${scenario.id}`, {})
        await Promise.allSettled([foreground])
        if (mounted) {
          for (const wid of [a, b]) await request('DELETE', `/v1/workspaces/${wid}`)
        }
      }
    }
    const tar = await fetch(`${url}/v1/workspaces/a/snapshot`, {
      signal: AbortSignal.timeout(10_000),
    })
    assert.equal(tar.status, 200, 'GET /v1/workspaces/a/snapshot')
    const upload = new FormData()
    upload.append('request', new Blob([JSON.stringify({ id: 'loaded' })]))
    upload.append('snapshot', new Blob([await tar.arrayBuffer()]))
    const loaded = await fetch(`${url}/v1/workspaces/load`, {
      method: 'POST',
      body: upload,
      signal: AbortSignal.timeout(10_000),
    })
    assert.equal(loaded.status, 201, `POST /v1/workspaces/load: ${await loaded.text()}`)
    assert.equal(
      (
        await request<Result>('POST', '/v1/workspaces/loaded/shell', {
          command: 'cat /work/curl_get-keep',
        })
      ).stdout,
      'keep\n',
    )
    console.log(`ok ${host}/snapshot_roundtrip`)

    // Lifecycle: cancel and kill by session, then close.
    const background = await request<Job>(
      'POST',
      '/v1/workspaces/a/shell?background=true&session_id=other',
      { command: 'sleep 30' },
      202,
    )
    await poll(async () =>
      (await request<Job>('GET', `/v1/jobs/${background.jobId}`)).status === 'running'
        ? true
        : undefined,
    )
    assert.deepEqual(await request('POST', '/v1/workspaces/a/sessions/other/cancel'), {
      canceled: 1,
    })
    assert.equal(
      (await request<Job>('POST', `/v1/jobs/${background.jobId}/wait`, {})).status,
      'canceled',
    )
    await request('POST', '/v1/workspaces/a/shell?session_id=other', { command: 'sleep 30 &' })
    assert.deepEqual(await request('POST', '/v1/workspaces/a/sessions/other/kill'), { killed: 1 })
    await request('POST', '/v1/workspaces/loaded/close')
    await request('GET', '/v1/workspaces/loaded', undefined, 404)
    console.log(`ok ${host}/lifecycle: session cancel, kill, close`)
  } catch (error) {
    console.error(errors)
    throw error
  } finally {
    clearTimeout(startup)
    lines.close()
    const watchdog = setTimeout(() => child.kill('SIGKILL'), 5000)
    child.kill('SIGTERM')
    await exited
    clearTimeout(watchdog)
    await rm(home, { recursive: true, force: true })
  }
  const [exitCode, signal] = await exited
  assert(output.includes('STOPPED\n'), `${host} did not finish shutdown: ${errors}`)
  // Uvicorn re-raises SIGTERM after its lifespan has finished.
  assert(
    signal === null || (host === 'python' && signal === 'SIGTERM'),
    `${host} was killed: ${String(signal)}`,
  )
  if (signal === null) assert.equal(exitCode, 0, `${host} shutdown failed: ${errors}`)
}

const selected = process.argv.slice(2).filter((arg) => arg !== '--mounts')
const hosts = selected.length === 0 ? ['python', 'typescript'] : selected
const mounts =
  mountFixtures !== undefined
    ? await mountFixtures.startMounts(
        hosts.flatMap((host) =>
          montyCases.flatMap(({ id }) => [`${host}-${id}-a`, `${host}-${id}-b`]),
        ),
      )
    : undefined
try {
  for (const host of hosts) {
    assert(host === 'python' || host === 'typescript', `unknown host: ${host}`)
    await run(host, mounts)
  }
} finally {
  await mounts?.close()
}
