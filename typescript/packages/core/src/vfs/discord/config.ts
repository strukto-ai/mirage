import { DiscordConfig as DiscordCredentialsSchema } from '../../core/discord/config.ts'
import { orderedTimes, timeRangeOrderError, timeRangeShape } from '../../core/time_config.ts'
import type { ConfigOf } from '../secrets.ts'

/**
 * A Discord mount: the CLI's credentials plus the mount's time scope. The CLI
 * keeps the credentials schema, so installing it with start_time/end_time
 * is refused rather than accepted and never applied.
 */
export const DiscordConfig = DiscordCredentialsSchema.extend({
  ...timeRangeShape,
}).refine(orderedTimes, timeRangeOrderError)

export type DiscordConfig = ConfigOf<typeof DiscordConfig>
