import { admissionMatcher, units } from '@struktoai/mirage-core/rs/policy'
import { Policies } from '@struktoai/mirage-core/policy/policies'
import type { Policy } from '@struktoai/mirage-core/policy/base'
import type {
  AdmissionRules,
  CommandContext,
  CommandRule,
} from '@struktoai/mirage-core/policy/types'
import type { Workspace } from '@struktoai/mirage-core/workspace/workspace/workspace'

function check(condition: boolean): asserts condition {
  if (!condition) throw new Error('benchmark correctness check failed')
}

export async function run(factory: (policy: Policy) => Workspace) {
  const samples: {
    name: string
    iterations: number
    first_ms: number
    ms: number
    errors: number
  }[] = []
  async function measure(name: string, iterations: number, operation: () => Promise<void>) {
    const first = performance.now()
    await operation()
    const firstMs = performance.now() - first
    const started = performance.now()
    for (let i = 0; i < iterations; i++) await operation()
    samples.push({
      name,
      iterations,
      first_ms: firstMs,
      ms: performance.now() - started,
      errors: 0,
    })
  }
  for (const size of [4, 256]) {
    const deny: CommandRule[] = Array.from({ length: size - 1 }, (_, i) => ({
      reason: `rule ${i}`,
      commands: [`blocked${i}`],
    }))
    deny.push({ reason: 'protected path', commands: ['cat'], paths: ['/private/*'] })
    const rules: AdmissionRules = {
      allow: null,
      ask: [],
      deny,
    }
    const matcher = admissionMatcher(rules)
    check(matcher.ask('has_rules') === true)
    await measure(`cache_same_${size}`, 500, async () => {
      check(admissionMatcher(rules) === matcher)
    })
    await measure(`cache_equal_${size}`, 500, async () => {
      check(
        admissionMatcher({
          ...rules,
          deny: rules.deny.map((rule) => ({
            ...rule,
            commands: [...(rule.commands ?? [])],
            ...(rule.paths === undefined ? {} : { paths: [...rule.paths] }),
          })),
        }) === matcher,
      )
    })
    const saved = deny.splice(0)
    check(admissionMatcher(rules).ask('has_rules') === false)
    deny.push(...saved)
    check(admissionMatcher(rules).ask('has_rules') === true)
    for (const count of [1, 256]) {
      const paths = Array.from({ length: count }, (_, i) => ({
        virtual_path: units(`/data/f${i}`),
        display_path: units(`/data/f${i}`),
      }))
      const facts = {
        tokens: [units('cat')],
        tool: false,
        cwd: units('/'),
        paths,
        operands: paths,
        walks: false,
        subtree: false,
        moves: false,
        move_target: null,
      }
      const deniedPath = {
        virtual_path: units('/private/secret'),
        display_path: units('/private/secret'),
      }
      const deniedPaths = [...paths.slice(0, -1), deniedPath]
      const deniedFacts = { ...facts, paths: deniedPaths, operands: deniedPaths }
      await measure(`match_rules_${size}_paths_${count}`, 50, async () => {
        const result = matcher.ask('decide', { facts }) as {
          outcome: string
          asks: number[]
          rule: number | null
        }
        check(result.outcome === 'allow' && result.asks.length === 0 && result.rule === null)
        const denied = matcher.ask('decide', { facts: deniedFacts }) as {
          outcome: string
          asks: number[]
          rule: number | null
          matched_path: number[] | null
        }
        check(denied.outcome === 'deny' && denied.asks.length === 0 && denied.rule === size - 1)
        check(JSON.stringify(denied.matched_path) === JSON.stringify(units('/private/secret')))
      })
    }
  }
  const context: CommandContext = { command: 'echo', argv: [], paths: [], cwd: '/' }
  for (const count of [0, 4, 64]) {
    let calls = 0
    const policies = new Policies(
      Array.from({ length: count }, () => ({
        preCommand() {
          calls++
          return null
        },
      })),
    )
    await measure(`composition_${count}`, 100, async () => {
      const before = calls
      check((await policies.preCommand(context)) === null)
      check(calls - before === count)
    })
  }
  let calls = 0
  let vfsCalls = 0
  let sessionCalls = 0
  const ws = factory({
    preVfs() {
      vfsCalls++
      return null
    },
    preSession() {
      sessionCalls++
      return null
    },
    preCommand(ctx) {
      calls++
      return ctx.command === 'rm' ? { kind: 'deny', reason: 'benchmark refusal' } : null
    },
  })
  ws.createSession('bench', { profile: 'bench' })
  try {
    check((await ws.shell("printf 'alpha\\nbeta\\n' > /data/report")).exitCode === 0)
    const cases: [string, string, string, number][] = [
      ['cat /data/report', 'alpha\nbeta\n', '', 0],
      ['ls /data', 'report\n', '', 0],
      ['export BENCH=value', '', '', 0],
      ['rm /data/report', '', 'rm: Permission denied\n', 126],
    ]
    for (const [index, [command, stdout, stderr, code]] of cases.entries()) {
      await measure(`shell_${index}`, 20, async () => {
        const before = calls
        const vfsBefore = vfsCalls
        const sessionBefore = sessionCalls
        const result = await ws.shell(command, { sessionId: 'bench' })
        check(
          result.exitCode === code && result.stdoutText === stdout && result.stderrText === stderr,
        )
        if (index !== 2) check(calls > before)
        if (index === 0) check(vfsCalls > vfsBefore)
        if (index === 2) check(sessionCalls > sessionBefore)
      })
    }
  } finally {
    await ws.close()
  }
  return samples
}
