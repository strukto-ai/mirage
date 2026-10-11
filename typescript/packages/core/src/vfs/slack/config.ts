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
  // Let grep -w and rg -w read only the channel days Slack search names
  // (`filesContaining`). Off by default: Slack indexes a message some time
  // after it is posted, and searches only message text, file names and
  // titles and reactions, so a word elsewhere in the JSON (a profile or
  // block field) is not found.
  contentSearch: z.boolean().optional(),
}).refine(orderedTimes, timeRangeOrderError)

export type SlackConfig = ConfigOf<typeof SlackConfigSchema>

export type SlackConfigRedacted = RedactedConfig<SlackConfig, 'token' | 'searchToken'>

export function redactSlackConfig(config: SlackConfig): SlackConfigRedacted {
  return redactConfigWithSchema(SlackConfigSchema, config) as unknown as SlackConfigRedacted
}

export function normalizeSlackConfig(input: Record<string, unknown>): SlackConfig {
  return parseConfigWithSchema(SlackConfigSchema, input)
}
