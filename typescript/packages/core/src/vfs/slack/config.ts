import { SlackConfig as SlackCredentialsSchema } from '../../core/slack/config.ts'
import { TimeRangeConfig } from '../../core/time_config.ts'
import type { ConfigOf } from '../secrets.ts'

/**
 * A Slack mount: the CLI's credentials plus the mount's time scope. The CLI
 * keeps the credentials schema, so installing it with start_time/end_time
 * is refused rather than accepted and never applied.
 */
export const SlackConfig = TimeRangeConfig.safeExtend({ ...SlackCredentialsSchema.shape })

export type SlackConfig = ConfigOf<typeof SlackConfig>
