// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'

const __HERE = fileURLToPath(new URL('.', import.meta.url))
dotenv.config({ path: resolve(__HERE, '../../../../.env.development') })

type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

function requireEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`${name} env var is required`)
  return value
}

// The Python seed drives the langfuse SDK; this one calls the same public
// REST endpoints the SDK does, with fetch, so the example adds no SDK.
const HOST = requireEnv('LANGFUSE_HOST').replace(/\/+$/, '')
const AUTH = Buffer.from(
  `${requireEnv('LANGFUSE_PUBLIC_KEY')}:${requireEnv('LANGFUSE_SECRET_KEY')}`,
).toString('base64')

async function api(method: 'GET' | 'POST', path: string, body?: Json): Promise<unknown> {
  const response = await fetch(`${HOST}${path}`, {
    method,
    headers: {
      Authorization: `Basic ${AUTH}`,
      'Content-Type': 'application/json',
      'x-langfuse-ingestion-version': '4',
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`${method} ${path}: HTTP ${String(response.status)} ${text.slice(0, 200)}`)
  }
  return text === '' ? null : (JSON.parse(text) as unknown)
}

interface PromptSpec {
  name: string
  prompt: string
  config: { [key: string]: Json }
  label: string
}

const PROMPTS: PromptSpec[] = [
  {
    name: 'summarize',
    prompt: 'Summarize the following text in {{style}} style:\n\n{{text}}',
    config: { model: 'gpt-4o', temperature: 0.3 },
    label: 'production',
  },
  {
    name: 'summarize',
    prompt: 'You are an expert summarizer. Summarize in {{style}} style:\n\n{{text}}',
    config: { model: 'gpt-4o', temperature: 0.2 },
    label: 'staging',
  },
  {
    name: 'classify',
    prompt: 'Classify the sentiment as positive, negative, or neutral:\n\n{{text}}',
    config: { model: 'gpt-4o-mini', temperature: 0 },
    label: 'production',
  },
  {
    name: 'extract-entities',
    prompt: 'Extract all named entities. Return as JSON.\n\n{{text}}',
    config: { model: 'gpt-4o', temperature: 0 },
    label: 'production',
  },
]

interface TraceSpec {
  traceName: string
  sessionId?: string
  userId: string
  tags: string[]
  input: Json
  output: Json
  model: string
}

const TRACES: TraceSpec[] = [
  {
    traceName: 'chat-completion',
    sessionId: 'chat-session-001',
    userId: 'user-alice',
    tags: ['chat', 'geography'],
    input: { messages: [{ role: 'user', content: 'What is the capital of France?' }] },
    output: { response: 'The capital of France is Paris.' },
    model: 'gpt-4o',
  },
  {
    traceName: 'chat-completion',
    sessionId: 'chat-session-001',
    userId: 'user-alice',
    tags: ['chat', 'geography'],
    input: { messages: [{ role: 'user', content: 'Tell me more about Paris' }] },
    output: { response: 'Paris is known for the Eiffel Tower and Louvre Museum.' },
    model: 'gpt-4o',
  },
  {
    traceName: 'chat-completion',
    sessionId: 'chat-session-002',
    userId: 'user-bob',
    tags: ['chat', 'science'],
    input: { messages: [{ role: 'user', content: 'Explain quantum computing' }] },
    output: { response: 'Quantum computing uses qubits that can be in superposition...' },
    model: 'gpt-4o',
  },
  {
    traceName: 'summarize-document',
    sessionId: 'chat-session-002',
    userId: 'user-bob',
    tags: ['summarization', 'science'],
    input: { text: 'A long research paper about quantum computing...' },
    output: { summary: 'This paper introduces a novel approach to error correction...' },
    model: 'gpt-4o',
  },
  {
    traceName: 'support-classify',
    sessionId: 'support-ticket-101',
    userId: 'user-charlie',
    tags: ['support', 'classification'],
    input: { text: "I can't log in, keeps showing error 403" },
    output: { category: 'authentication', priority: 'high' },
    model: 'gpt-4o-mini',
  },
  {
    traceName: 'support-respond',
    sessionId: 'support-ticket-101',
    userId: 'user-charlie',
    tags: ['support', 'response'],
    input: { ticket: "Can't log in, error 403" },
    output: { response: 'Please try clearing your browser cookies...' },
    model: 'gpt-4o',
  },
  {
    traceName: 'entity-extraction',
    userId: 'user-alice',
    tags: ['extraction', 'ner'],
    input: { text: 'Apple CEO Tim Cook announced new products in Cupertino.' },
    output: {
      entities: [
        { name: 'Apple', type: 'ORG' },
        { name: 'Tim Cook', type: 'PERSON' },
      ],
    },
    model: 'gpt-4o',
  },
  {
    traceName: 'chat-completion',
    userId: 'user-dave',
    tags: ['chat', 'creative'],
    input: { messages: [{ role: 'user', content: 'Write a haiku about programming' }] },
    output: {
      response: 'Code flows like water\nBugs swim in the logic stream\nDebug, compile, run',
    },
    model: 'gpt-4o',
  },
]

function attr(key: string, value: string | string[]): Json {
  if (Array.isArray(value)) {
    return { key, value: { arrayValue: { values: value.map((v) => ({ stringValue: v })) } } }
  }
  return { key, value: { stringValue: value } }
}

// One trace as OpenTelemetry spans, the way Langfuse v4 ingests it: a root
// span carrying the trace's name, user, session and tags, with a generation
// under it.
function traceSpans(spec: TraceSpec): Json[] {
  const nanos = String(BigInt(Date.now()) * 1_000_000n)
  const traceId = randomBytes(16).toString('hex')
  const rootId = randomBytes(8).toString('hex')
  const input = JSON.stringify(spec.input)
  const output = JSON.stringify(spec.output)
  const span = (spanId: string, name: string, attributes: Json[], parent?: string): Json => ({
    traceId,
    spanId,
    ...(parent !== undefined ? { parentSpanId: parent } : {}),
    name,
    kind: 1,
    startTimeUnixNano: nanos,
    endTimeUnixNano: nanos,
    attributes,
    status: {},
  })
  return [
    span(rootId, spec.traceName, [
      attr('langfuse.trace.name', spec.traceName),
      attr('langfuse.user.id', spec.userId),
      ...(spec.sessionId !== undefined ? [attr('langfuse.session.id', spec.sessionId)] : []),
      attr('langfuse.trace.tags', spec.tags),
      attr('langfuse.trace.metadata.env', 'production'),
      attr('langfuse.observation.input', input),
      attr('langfuse.observation.output', output),
    ]),
    span(
      randomBytes(8).toString('hex'),
      `${spec.traceName}-llm`,
      [
        attr('langfuse.observation.type', 'generation'),
        attr('langfuse.observation.model.name', spec.model),
        attr('langfuse.observation.input', input),
        attr('langfuse.observation.output', output),
        attr(
          'langfuse.observation.usage_details',
          JSON.stringify({ input: 50 + input.length, output: 30 + output.length }),
        ),
      ],
      rootId,
    ),
  ]
}

const QA_ITEMS: [Json, Json][] = [
  [{ question: 'What is the capital of France?' }, { answer: 'Paris' }],
  [{ question: 'Who wrote Romeo and Juliet?' }, { answer: 'Shakespeare' }],
  [{ question: 'What is the speed of light?' }, { answer: '299,792,458 m/s' }],
  [{ question: 'What is the largest planet?' }, { answer: 'Jupiter' }],
  [{ question: 'Who painted the Mona Lisa?' }, { answer: 'da Vinci' }],
]

const SENTIMENT_ITEMS: [Json, Json][] = [
  [{ text: 'I love this product!' }, { sentiment: 'positive' }],
  [{ text: 'Terrible experience' }, { sentiment: 'negative' }],
  [{ text: 'It was okay' }, { sentiment: 'neutral' }],
  [{ text: 'Best purchase ever' }, { sentiment: 'positive' }],
  [{ text: 'Completely broken' }, { sentiment: 'negative' }],
]

async function createDataset(
  name: string,
  description: string,
  items: [Json, Json][],
): Promise<void> {
  await api('POST', '/api/public/v2/datasets', { name, description })
  for (const [input, expectedOutput] of items) {
    await api('POST', '/api/public/dataset-items', { datasetName: name, input, expectedOutput })
  }
  console.log(`  ${name}: ${String(items.length)} items`)
}

async function main(): Promise<void> {
  const projects = (await api('GET', '/api/public/projects')) as { data: unknown[] }
  console.log('Auth check:', projects.data.length > 0)

  console.log('\n=== Creating prompts ===')
  for (const { name, prompt, config, label } of PROMPTS) {
    await api('POST', '/api/public/v2/prompts', {
      name,
      type: 'text',
      prompt,
      config,
      labels: [label],
    })
    console.log(`  created: ${name} [${label}]`)
  }

  console.log('\n=== Creating traces ===')
  const spans: Json[] = []
  for (const spec of TRACES) {
    spans.push(...traceSpans(spec))
    console.log(`  created: ${spec.traceName} (session=${spec.sessionId ?? '-'})`)
  }
  console.log(`\n  total: ${String(TRACES.length)} traces`)

  console.log('\n=== Creating datasets ===')
  await createDataset('qa-eval', 'QA evaluation', QA_ITEMS)
  await createDataset('sentiment-eval', 'Sentiment classification', SENTIMENT_ITEMS)

  console.log('\n=== Flushing ===')
  await api('POST', '/api/public/otel/v1/traces', {
    resourceSpans: [
      { resource: { attributes: [] }, scopeSpans: [{ scope: { name: 'seed' }, spans }] },
    ],
  })
  await sleep(3000)

  console.log('\n=== Verifying ===')
  const traces = (await api(
    'GET',
    '/api/public/v2/observations?isRootObservation=true&limit=5',
  )) as {
    data: { name: string | null; sessionId: string | null }[]
  }
  console.log(`  traces: ${String(traces.data.length)} found`)
  for (const t of traces.data.slice(0, 3)) {
    console.log(`    ${String(t.name)} (session=${String(t.sessionId)})`)
  }

  const summarize = (await api('GET', '/api/public/v2/prompts/summarize')) as { version: number }
  console.log(`  summarize prompt: v${String(summarize.version)}`)

  console.log('\nDone!')
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
