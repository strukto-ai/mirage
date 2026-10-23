import { timeRangeShape, orderedTimes, timeRangeOrderError } from '../../core/time_config.ts'
import { SlackConfigSchema as SlackCredentialsSchema } from '../../core/slack/config.ts'
import {
  parseConfigWithSchema,
  redactConfigWithSchema,
  type ConfigOf,
  type RedactedConfig,
  z,
} from '../secrets.ts'

/**
 * A Slack mount: the CLI's credentials plus the mount's time scope. The CLI
 * keeps the credentials schema, so installing it with start_time/end_time
 * is refused rather than accepted and never applied.
 */
const SlackConfigSchema = SlackCredentialsSchema.extend({
  ...timeRangeShape,
  fullScanLimit: z.number().int().min(-1).optional().meta({
    description:
      'Most files one command walks under a folder: `grep -r`, `find` and other walks stop there, and a larger glob, `tar -c`, `cp -r` or `rm -r` is refused. `-1` lifts the limit and reads every file without asking Slack search, which lags posts and covers only message text, file names, titles and reactions.',
    default: 1000,
  }),
}).refine(orderedTimes, timeRangeOrderError)

export type SlackConfig = ConfigOf<typeof SlackConfigSchema>

export type SlackConfigRedacted = RedactedConfig<SlackConfig, 'token' | 'searchToken'>

export function redactSlackConfig(config: SlackConfig): SlackConfigRedacted {
  return redactConfigWithSchema(SlackConfigSchema, config) as unknown as SlackConfigRedacted
}

export function normalizeSlackConfig(input: Record<string, unknown>): SlackConfig {
  return parseConfigWithSchema(SlackConfigSchema, input)
}
