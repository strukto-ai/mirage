import { timeRangeShape, orderedTimes, timeRangeOrderError } from '../../core/time_config.ts'
import { SlackConfigSchema as SlackCredentialsSchema } from '../../core/slack/config.ts'
import {
  parseConfigWithSchema,
  redactConfigWithSchema,
  type ConfigOf,
  type RedactedConfig,
} from '../secrets.ts'

/**
 * A Slack mount: the CLI's credentials plus the mount's time scope. The CLI
 * keeps the credentials schema, so installing it with start_time/end_time
 * is refused rather than accepted and never applied.
 */
const SlackConfigSchema = SlackCredentialsSchema.extend({
  ...timeRangeShape,
}).refine(orderedTimes, timeRangeOrderError)

export type SlackConfig = ConfigOf<typeof SlackConfigSchema>

export type SlackConfigRedacted = RedactedConfig<SlackConfig, 'token' | 'searchToken'>

export function redactSlackConfig(config: SlackConfig): SlackConfigRedacted {
  return redactConfigWithSchema(SlackConfigSchema, config) as unknown as SlackConfigRedacted
}

export function normalizeSlackConfig(input: Record<string, unknown>): SlackConfig {
  return parseConfigWithSchema(SlackConfigSchema, input)
}
