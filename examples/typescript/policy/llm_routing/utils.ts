import { choice, TypeSafeClient } from '@typesafe-ai/sdk'
import { config as loadEnv } from 'dotenv'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import OpenAI from 'openai'
import { zodTextFormat } from 'openai/helpers/zod'
import type { z } from 'zod'
import { RuntimeChoice } from './config.ts'

loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../../../.env.development') })

type Choice = z.infer<typeof RuntimeChoice>

const CHOICES = new Map<string, Choice>()

/** Ask the model where a line runs: Jev for a jev model, else OpenAI; each line once, so its preview and its run agree. */
export async function parseRuntime(
  model: string,
  task: string,
  runtimes: Record<string, string>,
  line: string,
): Promise<Choice> {
  const known = CHOICES.get(line)
  if (known !== undefined) return known
  const ask = model.startsWith('jev') ? askJev : askOpenAI
  const picked = await ask(model, task, runtimes, line)
  CHOICES.set(line, picked)
  return picked
}

/** Ask an OpenAI model for a RuntimeChoice, its reason in its words. */
async function askOpenAI(
  model: string,
  task: string,
  runtimes: Record<string, string>,
  line: string,
): Promise<Choice> {
  const prompt = [
    `${task} Say why in one sentence.`,
    ...Object.entries(runtimes).map(([name, about]) => `${name}: ${about}`),
  ].join('\n')
  const done = await new OpenAI({ timeout: 10_000 }).responses.parse({
    model,
    instructions: prompt,
    input: line,
    text: { format: zodTextFormat(RuntimeChoice, 'runtime_choice') },
  })
  if (done.output_parsed === null) throw new Error('the model chose no runtime')
  return done.output_parsed
}

/** Ask a Jev model to choose, its reason the confidence it reports. */
async function askJev(
  model: string,
  task: string,
  runtimes: Record<string, string>,
  line: string,
): Promise<Choice> {
  const client = new TypeSafeClient({ apiKey: process.env.JEV_API_KEY, timeout: 10_000 })
  const done = await client.systemOne({
    model,
    state: line,
    questions: { runtime: choice(task, runtimes) },
  })
  const answer = done.answers.runtime
  return RuntimeChoice.parse({
    runtime: answer.choice,
    reason: `confidence ${answer.confidence.toFixed(2)}`,
  })
}
