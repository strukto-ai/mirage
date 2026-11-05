import { z } from 'zod'
import type { OpenStream } from './stream.ts'
import { decodeText } from '../shell/bytes.ts'

const Progress = z.object({
  consumed: z.number().int().nonnegative(),
  retained: z.number().int().nonnegative(),
})

export function progress(stream: OpenStream): z.infer<typeof Progress> {
  return Progress.parse(JSON.parse(decodeText(stream.metadata())))
}
