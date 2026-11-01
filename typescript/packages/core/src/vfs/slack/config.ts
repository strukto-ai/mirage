import { SlackConfig as SlackCredentialsSchema } from '../../core/slack/config.ts'
import { orderedTimes, timeRangeOrderError, timeRangeShape } from '../../core/time_config.ts'
import type { ConfigOf } from '../secrets.ts'

/**
 * A Slack mount: the CLI's credentials plus the mount's time scope. The CLI
 * keeps the credentials schema, so installing it with start_time/end_time
 * is refused rather than accepted and never applied.
 */
export const SlackConfig = SlackCredentialsSchema.extend({
  ...timeRangeShape,
}).refine(orderedTimes, timeRangeOrderError)

export type SlackConfig = ConfigOf<typeof SlackConfig>
