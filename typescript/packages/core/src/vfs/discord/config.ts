import { timeRangeShape, orderedTimes, timeRangeOrderError } from '../../core/time_config.ts'
import { DiscordConfigSchema as DiscordCredentialsSchema } from '../../core/discord/config.ts'
import {
  parseConfigWithSchema,
  redactConfigWithSchema,
  type ConfigOf,
  type RedactedConfig,
  z,
} from '../secrets.ts'

/**
 * A Discord mount: the CLI's credentials plus the mount's time scope. The CLI
 * keeps the credentials schema, so installing it with start_time/end_time
 * is refused rather than accepted and never applied.
 */
const DiscordConfigSchema = DiscordCredentialsSchema.extend({
  ...timeRangeShape,
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
}).refine(orderedTimes, timeRangeOrderError)

export type DiscordConfig = ConfigOf<typeof DiscordConfigSchema>

export type DiscordConfigRedacted = RedactedConfig<DiscordConfig, 'token'>

export function redactDiscordConfig(config: DiscordConfig): DiscordConfigRedacted {
  return redactConfigWithSchema(DiscordConfigSchema, config) as unknown as DiscordConfigRedacted
}

export function normalizeDiscordConfig(input: Record<string, unknown>): DiscordConfig {
  return parseConfigWithSchema(DiscordConfigSchema, input)
}
