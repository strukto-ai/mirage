import { MountMode, RAMVFS, Workspace } from '@struktoai/mirage-node'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

const LOG =
  '09:00 INFO  boot\n' +
  '09:01 ERROR disk full on /var\n' +
  '09:02 INFO  retry\n' +
  '09:03 ERROR disk full on /var\n' +
  '09:04 WARN  slow response\n' +
  '09:05 ERROR timeout talking to db\n'

const PROFILES = {
  agent: {},
  operator: { processes: 'workspace' },
  auditor: { processes: { list: 'workspace' } },
  sandboxed: { processes: { max: 3 } },
} as const

function indent(text: string): string {
  return '  ' + text.replace(/\n$/, '').replaceAll('\n', '\n  ')
}

async function sh(ws: Workspace, line: string, sessionId?: string): Promise<string> {
  const io = await ws.shell(line, sessionId === undefined ? {} : { sessionId })
  const out = DEC.decode(io.stdout)
  const err = io.stderrText
  console.log(`${sessionId !== undefined ? `[${sessionId}] ` : ''}$ ${line}`)
  for (const text of [out, err]) if (text !== '') console.log(indent(text))
  return out
}

async function backgroundWork(ws: Workspace): Promise<void> {
  console.log('=== 1. background work an agent can manage by PID ===')
  await sh(ws, 'sleep 30 & slow=$!; echo slow=$slow')
  await sh(
    ws,
    '{ sleep 0.3; grep -c ERROR /data/app.log; } > /data/errors.txt & scan=$!; echo scan=$scan',
  )
  await sh(ws, 'jobs -l')
  await sh(ws, 'ps')
  await sh(ws, 'kill "$slow"; echo "kill exit=$?"')
  await sh(ws, 'wait "$scan"; echo "scan exit=$?"; cat /data/errors.txt')
  await sh(ws, 'ps | cat')
}

async function driveFromHost(ws: Workspace): Promise<void> {
  console.log('\n=== 2. drive a mirage command from the host like Popen ===')
  const child = ws.spawn({ argv: ['grep', '-n', 'ERROR'] })
  const started = Date.now()
  const stamp = (): string => `+${String(Date.now() - started).padStart(4)}ms`
  const feed = (async () => {
    for (const line of LOG.split(/(?<=\n)/)) {
      console.log(`  ${stamp()} stdin  ${line.trimEnd()}`)
      await child.stdin.write(ENC.encode(line))
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    child.stdin.close()
  })()
  for await (const chunk of child.stdout) {
    console.log(`  ${stamp()} stdout ${DEC.decode(chunk).trimEnd()}`)
  }
  await feed
  const info = await child.wait()
  console.log(`  grep pid=${String(child.pid)} exit=${String(info.exitCode)}`)

  const tally = ws.spawn({ argv: ['sh', '-c', "cut -d' ' -f2 | sort | uniq -c"] })
  const counted = await tally.communicate(ENC.encode(LOG))
  console.log("  sh -c 'cut | sort | uniq -c' ->")
  console.log(indent(DEC.decode(counted.stdout)))

  const literal = ws.spawn({ argv: ['echo', '$(rm -rf /data)'] })
  const echoed = await literal.communicate()
  console.log('  argv is literal, no shell expansion:', DEC.decode(echoed.stdout).trimEnd())

  const stuck = ws.spawn({ argv: ['sleep', '30'] })
  const t0 = Date.now()
  stuck.terminate()
  const stopped = await stuck.wait()
  console.log(
    `  terminate sleep 30 -> exit=${String(stopped.exitCode)} after ${String(Date.now() - t0)}ms`,
  )
}

async function scopedByProfile(ws: Workspace): Promise<void> {
  console.log("\n=== 3. agents cannot see or kill each other's work ===")
  ws.createSession('agent-a', { profile: 'agent' })
  ws.createSession('agent-b', { profile: 'agent' })
  ws.createSession('audit', { profile: 'auditor' })
  ws.createSession('ops', { profile: 'operator' })
  const pid = (await sh(ws, 'sleep 30 & echo $!', 'agent-a')).trim()
  await sh(ws, 'ps', 'agent-b')
  await sh(ws, `kill ${pid}`, 'agent-b')
  await sh(ws, 'ps', 'audit')
  await sh(ws, `kill ${pid}`, 'audit')
  await sh(ws, `kill ${pid}; echo "kill exit=$?"`, 'ops')
}

async function cappedByProfile(ws: Workspace): Promise<void> {
  console.log('\n=== 4. a process cap stops a runaway loop ===')
  ws.createSession('sandbox', { profile: 'sandboxed' })
  await sh(ws, 'n=0; while true; do sleep 30 & n=$((n+1)); done', 'sandbox')
  await sh(ws, 'echo "status=$? started=$n"; jobs', 'sandbox')
  await sh(ws, 'kill %1; kill %2', 'sandbox')
  await ws.processes.drain()
  await sh(ws, 'echo a | tr a b', 'sandbox')
}

async function nothingOutlivesClose(ws: Workspace): Promise<void> {
  console.log('\n=== 5. closing the workspace stops everything it started ===')
  await sh(ws, 'sleep 60 &', 'agent-a')
  await sh(ws, 'sleep 60 | sleep 60 &', 'agent-b')
  ws.spawn({ argv: ['sleep', '60'] })
  const live = ws.processes.live().map((p) => p.info)
  console.log(
    `  live before close: ${String(live.length)} -> ` +
      live.map((i) => `${String(i.pid)}:${i.command ?? ''}`).join(', '),
  )
  const t0 = Date.now()
  await ws.close()
  console.log(
    `  live after close:  ${String(ws.processes.live().length)} (close took ${String(Date.now() - t0)}ms)`,
  )
}

async function main(): Promise<void> {
  const ws = new Workspace(
    { '/data': new RAMVFS() },
    { mode: MountMode.WRITE, profiles: PROFILES, profile: 'agent' },
  )
  await ws.shell(`printf '%s' '${LOG}' > /data/app.log`)
  await backgroundWork(ws)
  await driveFromHost(ws)
  await scopedByProfile(ws)
  await cappedByProfile(ws)
  await nothingOutlivesClose(ws)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
