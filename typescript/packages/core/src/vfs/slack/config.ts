import { timeRangeShape, orderedTimes, timeRangeOrderError } from '../../core/time_config.ts'
import { SlackConfigSchema as SlackCredentialsSchema } from '../../core/slack/config.ts'
import { type ConfigOf, type RedactedConfig } from '../secrets.ts'

/**
 * A Slack mount: the CLI's credentials plus the mount's time scope. The CLI
 * keeps the credentials schema, so installing it with start_time/end_time
 * is refused rather than accepted and never applied.
 */
export const SlackConfigSchema = SlackCredentialsSchema.extend({
  ...timeRangeShape,
}).refine(orderedTimes, timeRangeOrderError)

export type SlackConfig = ConfigOf<typeof SlackConfigSchema>

export type SlackConfigRedacted = RedactedConfig<SlackConfig, 'token' | 'searchToken'>
