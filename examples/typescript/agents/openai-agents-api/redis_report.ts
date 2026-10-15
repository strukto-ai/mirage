// Total a CSV with OpenAI's Agents API, working in a Mirage workspace.
//
// The agent runs on OpenAI's servers in a self-hosted environment: its
// shell commands, file reads and patches reach workspace `demo` through
// `codex exec-server forward` and `mirage codex-exec`, both started here.
// The agent totals /workspace/orders.csv per customer and saves the
// table to /redis/report.md, which stays in Redis after the run.
//
// Usage:
//   docker run -d -p 6379:6379 redis
//   npm install -g @struktoai/mirage-cli redis @openai/codex@alpha
//   mirage workspace create workspace.yaml --id demo
//   pnpm --filter @struktoai/mirage-examples exec \
//     tsx agents/openai-agents-api/redis_report.ts
//
// workspace.yaml mounts RAM at /workspace and Redis at /redis, as the
// OpenAI Agents API page shows. .env.development holds OPENAI_API_KEY and
// OPENAI_EXECUTOR_API_KEY (an environment key from the Agents tab).

import { config as loadEnv } from 'dotenv'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import OpenAI from 'openai'

loadEnv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../../.env.development'),
})

const WORKSPACE = 'demo'
const LISTEN = '127.0.0.1:8790'
const CODEX = process.env.CODEX ?? 'codex'

const ORDERS = [
  'customer,item,amount',
  'acme,widget,120',
  'globex,gadget,75',
  'acme,gizmo,30',
  'initech,widget,60',
  'globex,widget,45',
  '',
].join('\n')

const TASK =
  'Total the amount per customer in /workspace/orders.csv and save the ' +
  'totals as a markdown table, largest first, to /redis/report.md.'

function mirageShell(line: string, input = ''): string {
  const done = spawnSync('mirage', ['shell', '-w', WORKSPACE, '-c', line], {
    input,
    encoding: 'utf8',
  })
  if (done.status !== 0) throw new Error(done.stderr)
  return done.stdout
}

mirageShell('cat > /workspace/orders.csv', ORDERS)
const relay = spawn('mirage', ['codex-exec', WORKSPACE, '--listen', LISTEN], {
  stdio: ['ignore', 'inherit', 'pipe'],
})
console.log(
  await new Promise<string>((done) => createInterface({ input: relay.stderr }).once('line', done)),
)

const client = new OpenAI()
const session = await client.beta.agents.sessions.create({
  agent: { model: 'gpt-6-luna' },
  environment: { type: 'self_hosted', workspace_directory: '/workspace' },
})
const environment = session.environment
if (environment?.type !== 'self_hosted') throw new Error('the session has no self-hosted environment')
const forward = spawn(
  CODEX,
  [
    'exec-server',
    'forward',
    '--connect',
    `ws://${LISTEN}`,
    '--remote',
    environment.remote_url,
    '--environment-id',
    environment.id,
  ],
  {
    stdio: 'inherit',
    env: { ...process.env, CODEX_API_KEY: process.env.OPENAI_EXECUTOR_API_KEY },
  },
)
try {
  const stream = await client.beta.agents.sessions.events.stream(session.id)
  await client.beta.agents.sessions.events.create(session.id, {
    events: [
      {
        type: 'agent.session.input.message',
        input: [{ role: 'user', content: [{ type: 'input_text', text: TASK }] }],
      },
    ],
    'Idempotency-Key': randomUUID(),
  })
  for await (const event of stream) {
    if (event.type === 'agent.session.turn.output_text.delta') {
      process.stdout.write(event.delta)
    } else if (
      event.type === 'agent.session.turn.completed' ||
      event.type === 'agent.session.turn.failed' ||
      event.type === 'agent.session.turn.cancelled'
    ) {
      console.log(`\n[${event.type}]`)
      break
    }
  }
} finally {
  forward.kill()
  relay.kill()
}

console.log('\n=== /redis/report.md (from Redis, through Mirage) ===')
console.log(mirageShell('cat /redis/report.md'))
