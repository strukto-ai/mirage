import { config as loadEnv } from 'dotenv'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import Anthropic from '@anthropic-ai/sdk'
import { MountMode, RAMVFS, RedisVFS, Workspace } from '@struktoai/mirage-node'
import { mirageTools } from '@struktoai/mirage-agents/claude-managed-agents'

loadEnv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../../.env.development'),
})

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

const ws = new Workspace(
  {
    '/workspace': new RAMVFS(),
    '/redis': new RedisVFS({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' }),
  },
  { mode: MountMode.WRITE },
)
await ws.vfs.write('/workspace/orders.csv', ORDERS)

const environmentId = process.env.ANTHROPIC_ENVIRONMENT_ID ?? ''
const client = new Anthropic()
const agent = await client.beta.agents.create({
  name: 'Mirage orders report',
  model: 'claude-opus-5-5',
  tools: [
    {
      type: 'agent_toolset_20260401',
      default_config: { enabled: true, permission_policy: { type: 'always_allow' } },
      configs: [
        { name: 'web_fetch', enabled: false },
        { name: 'web_search', enabled: false },
      ],
    },
  ],
})
const session = await client.beta.sessions.create({
  agent: { type: 'agent', id: agent.id, version: agent.version },
  environment_id: environmentId,
})
const worker = client.beta.environments.work.worker({
  environmentId,
  environmentKey: process.env.ANTHROPIC_ENVIRONMENT_KEY ?? '',
  tools: mirageTools(ws),
})
const stop = new AbortController()
const serving = worker.run(stop.signal)
try {
  const stream = await client.beta.sessions.events.stream(session.id)
  await client.beta.sessions.events.send(session.id, {
    events: [{ type: 'user.message', content: [{ type: 'text', text: TASK }] }],
  })
  for await (const event of stream) {
    if (event.type === 'agent.tool_use') {
      console.log(`  -> ${event.name} ${JSON.stringify(event.input)}`)
    } else if (event.type === 'agent.message') {
      for (const block of event.content) if (block.type === 'text') console.log(block.text)
    } else if (event.type === 'session.status_idle') {
      if (event.stop_reason.type !== 'requires_action') break
    } else if (event.type === 'session.status_terminated') {
      break
    }
  }
} finally {
  stop.abort()
  await serving
  await client.beta.agents.archive(agent.id)
}

console.log('\n=== /redis/report.md (from Redis, through Mirage) ===')
console.log(new TextDecoder().decode(await ws.vfs.read('/redis/report.md')))
await ws.close()
