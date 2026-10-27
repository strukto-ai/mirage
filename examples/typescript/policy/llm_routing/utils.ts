import { config as loadEnv } from 'dotenv'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import OpenAI from 'openai'
import { zodTextFormat } from 'openai/helpers/zod'
import type { z } from 'zod'
import { RuntimeChoice } from './config.ts'

loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../../.env.development') })

const CLIENT = new OpenAI({ timeout: 10_000 })

/** Ask the model where a line runs, parsed as a RuntimeChoice. */
export async function parseRuntime(
  model: string,
  prompt: string,
  line: string,
): Promise<z.infer<typeof RuntimeChoice>> {
  const done = await CLIENT.responses.parse({
    model,
    instructions: prompt,
    input: line,
    text: { format: zodTextFormat(RuntimeChoice, 'runtime_choice') },
  })
  if (done.output_parsed === null) throw new Error('the model chose no runtime')
  return done.output_parsed
}
