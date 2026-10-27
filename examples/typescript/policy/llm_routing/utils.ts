import { config as loadEnv } from 'dotenv'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import OpenAI from 'openai'
import { zodTextFormat } from 'openai/helpers/zod'
import type { z } from 'zod'
import { RuntimeChoice } from './config.ts'

loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../../.env.development') })

const CLIENT = new OpenAI({ timeout: 10_000 })
const CHOICES = new Map<string, z.infer<typeof RuntimeChoice>>()

/** Ask the model where a line runs, parsed as a RuntimeChoice; each line once, so its preview and its run agree. */
export async function parseRuntime(
  model: string,
  prompt: string,
  line: string,
): Promise<z.infer<typeof RuntimeChoice>> {
  const known = CHOICES.get(line)
  if (known !== undefined) return known
  const done = await CLIENT.responses.parse({
    model,
    instructions: prompt,
    input: line,
    text: { format: zodTextFormat(RuntimeChoice, 'runtime_choice') },
  })
  if (done.output_parsed === null) throw new Error('the model chose no runtime')
  CHOICES.set(line, done.output_parsed)
  return done.output_parsed
}
