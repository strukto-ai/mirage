import { z } from 'zod'
import { rstripSlash } from '../../utils/slash.ts'
import {
  type ConfigOf,
  parseConfigWithSchema,
  redactConfigWithSchema,
  type RedactedConfig,
  secretStr,
} from '../secrets.ts'

type Mem0ScopeKind = 'user' | 'agent' | 'run'

export interface Mem0ConfigResolved {
  apiKey: string
  host: string
  userId: string | null
  agentId: string | null
  runId: string | null
  defaultPageSize: number
  defaultSearchLimit: number
  scopeKind: Mem0ScopeKind
  scopeFilter: Record<string, string>
}

const Mem0ConfigSchema = z.object({
  apiKey: secretStr(),
  host: z.string().optional(),
  userId: z.string().optional(),
  agentId: z.string().optional(),
  runId: z.string().optional(),
  defaultPageSize: z.number().optional(),
  defaultSearchLimit: z.number().optional(),
})

export type Mem0Config = ConfigOf<typeof Mem0ConfigSchema>

export type Mem0ConfigRedacted = RedactedConfig<Mem0Config, 'apiKey'>

export function redactMem0Config(config: Mem0Config): Mem0ConfigRedacted {
  return redactConfigWithSchema(Mem0ConfigSchema, config) as unknown as Mem0ConfigRedacted
}

export function normalizeMem0Config(input: Record<string, unknown>): Mem0Config {
  return parseConfigWithSchema(Mem0ConfigSchema, input)
}

function positive(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isInteger(resolved) || resolved <= 0) throw new Error(`${name} must be positive`)
  return resolved
}

export function resolveMem0Config(config: Mem0Config): Mem0ConfigResolved {
  const scopes = [
    ['user', 'user_id', config.userId] as const,
    ['agent', 'agent_id', config.agentId] as const,
    ['run', 'run_id', config.runId] as const,
  ].filter((scope) => scope[2] !== undefined)
  if (scopes.length !== 1) {
    throw new Error('Mem0Config requires exactly one of userId, agentId, runId')
  }
  const scope = scopes[0]
  if (scope?.[2]?.trim() === '' || scope?.[2] === undefined) {
    throw new Error('Mem0 scope id cannot be empty')
  }
  return {
    apiKey: config.apiKey,
    host: rstripSlash(config.host ?? 'https://api.mem0.ai'),
    userId: config.userId ?? null,
    agentId: config.agentId ?? null,
    runId: config.runId ?? null,
    defaultPageSize: positive(config.defaultPageSize, 100, 'defaultPageSize'),
    defaultSearchLimit: positive(config.defaultSearchLimit, 10, 'defaultSearchLimit'),
    scopeKind: scope[0],
    scopeFilter: { [scope[1]]: scope[2] },
  }
}
