import { z } from 'zod'
import { rstripSlash } from '../../utils/slash.ts'
import {
  type ConfigOf,
  parseConfigWithSchema,
  redactConfigWithSchema,
  type RedactedConfig,
  secretStr,
} from '../secrets.ts'

export interface Mem0ConfigResolved {
  apiKey: string
  host: string
  userId: string | null
  agentId: string | null
  runId: string | null
  defaultPageSize: number
  defaultSearchLimit: number
  scopeFilter: Record<string, string>
}

const Mem0ConfigSchema = z.object({
  apiKey: secretStr().describe('Mem0 Platform API key.'),
  host: z
    .string()
    .optional()
    .meta({ description: 'Mem0 API base URL.', default: 'https://api.mem0.ai' }),
  userId: z
    .string()
    .optional()
    .describe("Mount this user's memories. Set exactly one of `userId`, `agentId` and `runId`."),
  agentId: z
    .string()
    .optional()
    .describe("Mount this agent's memories. Set exactly one of `userId`, `agentId` and `runId`."),
  runId: z
    .string()
    .optional()
    .describe("Mount this run's memories. Set exactly one of `userId`, `agentId` and `runId`."),
  defaultPageSize: z.number().optional().meta({
    description: 'Memories fetched per request while listing the scope.',
    default: 100,
  }),
  defaultSearchLimit: z.number().optional().meta({
    description: 'How many results `search` returns unless the line sets `top_k`.',
    default: 10,
  }),
  fullScanLimit: z
    .number()
    .int()
    .min(-1)
    .optional()
    .meta({
      description:
        'Most files one command walks under a folder: `grep -r`, `find` and other walks stop there, and a larger glob, `tar -c`, `cp -r` or `rm -r` is refused. `-1` lifts the limit.',
      default: 1000,
    }),
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
    ['user_id', config.userId] as const,
    ['agent_id', config.agentId] as const,
    ['run_id', config.runId] as const,
  ].filter((scope) => scope[1] !== undefined)
  if (scopes.length !== 1) {
    throw new Error('Mem0Config requires exactly one of userId, agentId, runId')
  }
  const scope = scopes[0]
  if (scope?.[1]?.trim() === '' || scope?.[1] === undefined) {
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
    scopeFilter: { [scope[0]]: scope[1] },
  }
}
