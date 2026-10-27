import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Workspace, configToWorkspaceArgs, loadWorkspaceConfigFile } from '@struktoai/mirage-node'
import { parseRuntime } from './utils.ts'

const CONFIG = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../python/policy/llm_routing/workspace.yaml',
)

async function main(): Promise<void> {
  const args = await configToWorkspaceArgs(loadWorkspaceConfigFile(CONFIG))
  const ws = new Workspace(args.mounts, {
    ...args.options,
    policyFunctions: { parse_runtime: parseRuntime },
  })
  try {
    for (const line of [
      'python3 -c "print(sum(range(1, 101)))"',
      'python3 -c "import sqlite3; print(sqlite3.sqlite_version)"',
    ]) {
      console.log(`$ ${line}`)
      const plan = await ws.explain(line)
      console.log(`  plan: ${plan.outcome}`)
      for (const answer of plan.answers) {
        const where = answer.kind === 'route' ? ` ${answer.runtime}` : ''
        console.log(`    ${answer.kind}${where}: ${answer.reason ?? ''}`)
        console.log(`      by ${answer.policy ?? ''}`)
      }
      const res = await ws.shell(line)
      console.log(`  output: ${new TextDecoder().decode(res.stdout ?? new Uint8Array()).trim()}`)
      if (res.exitCode !== 0)
        console.log(`  exit ${res.exitCode}: ${new TextDecoder().decode(res.stderr).trim()}`)
    }
  } finally {
    await ws.close()
  }
}

await main()
