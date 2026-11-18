import { z } from 'zod'
import { parseTime } from './time_range.ts'

const timestamp = z
  .string()
  .superRefine((value, ctx) => {
    try {
      parseTime(value)
    } catch (error) {
      ctx.addIssue({
        code: 'custom',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  })
  .nullable()

export const orderedTimes = z.refine<{
  startTime?: string | null | undefined
  endTime?: string | null | undefined
}>(
  (config) =>
    config.startTime == null ||
    config.endTime == null ||
    Date.parse(config.startTime) < Date.parse(config.endTime),
  { message: 'start_time must be earlier than end_time' },
)

export const TimeRangeConfig = z
  .object({
    startTime: timestamp
      .optional()
      .describe(
        "Start of the mount's time scope, inclusive: an RFC 3339 timestamp with an explicit timezone and at most millisecond precision. Unset leaves the start open.",
      ),
    endTime: timestamp
      .optional()
      .describe(
        "End of the mount's time scope, exclusive, in the same format as `startTime`, which it must follow. Unset leaves the end open.",
      ),
  })
  .check(orderedTimes)
