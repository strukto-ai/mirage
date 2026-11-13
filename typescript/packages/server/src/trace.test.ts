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

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  context,
  propagation,
  trace,
  type Context,
  type Span,
  type SpanContext,
  type SpanOptions,
  type Tracer,
} from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { W3CTraceContextPropagator } from '@opentelemetry/core'
import { buildApp } from './app.ts'
import { requestContext } from './trace.ts'

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736'
const PARENT_ID = '00f067aa0ba902b7'
const TRACEPARENT = `00-${TRACE_ID}-${PARENT_ID}-01`

interface Started {
  name: string
  parent: SpanContext | undefined
  context: SpanContext
}

/** Record each span started: its name, its own context and the span it is under. */
function exported(): Started[] {
  const spans: Started[] = []
  const fake = {
    startSpan(name: string, _options: SpanOptions = {}, ctx: Context = context.active()) {
      const parent = trace.getSpanContext(ctx)
      const started: Started = {
        name,
        parent,
        context: {
          traceId: parent?.traceId ?? String(spans.length + 1).padStart(32, '0'),
          spanId: String(spans.length + 1).padStart(16, '0'),
          traceFlags: 1,
        },
      }
      spans.push(started)
      const span = {
        isRecording: () => true,
        setAttribute: () => span,
        end: () => undefined,
        spanContext: () => started.context,
      }
      return span as unknown as Span
    },
  } as unknown as Tracer
  trace.setGlobalTracerProvider({ getTracer: () => fake })
  return spans
}

function spanOf(ctx: Context): SpanContext | undefined {
  return trace.getSpanContext(ctx)
}

beforeAll(() => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())
  propagation.setGlobalPropagator(new W3CTraceContextPropagator())
})

afterAll(() => {
  trace.disable()
  propagation.disable()
  context.disable()
})

describe('requestContext', () => {
  it('joins the caller trace when no span is open', () => {
    const joined = spanOf(requestContext({ traceparent: TRACEPARENT }))
    expect([joined?.traceId, joined?.spanId, joined?.isRemote]).toEqual([TRACE_ID, PARENT_ID, true])
  })

  it('starts no trace without a traceparent', () => {
    expect(spanOf(requestContext({}))).toBeUndefined()
  })

  it('starts no trace from a bad traceparent', () => {
    expect(spanOf(requestContext({ traceparent: '00-zz-01' }))).toBeUndefined()
  })

  // An instrumentation library (Fastify's, say) has already opened a span
  // for the request under the caller's; the line goes under that span.
  it('keeps a span already open over the header', () => {
    const opened: SpanContext = {
      traceId: '1'.padStart(32, '0'),
      spanId: '2'.padStart(16, '0'),
      traceFlags: 1,
    }
    const ctx = context.with(trace.setSpanContext(context.active(), opened), () =>
      requestContext({ traceparent: TRACEPARENT }),
    )
    expect(spanOf(ctx)).toEqual(opened)
  })
})

// A shell request that carries a traceparent and no instrumentation puts
// its line's command span in the caller's trace, under the caller's span.
describe('a shell request', () => {
  it('puts its line in the caller trace', async () => {
    const spans = exported()
    const app = buildApp()
    try {
      await app.inject({
        method: 'POST',
        url: '/v1/workspaces',
        payload: { id: 'traced', config: { mounts: { '/': { vfs: 'ram', mode: 'write' } } } },
      })
      const traced = await app.inject({
        method: 'POST',
        url: '/v1/workspaces/traced/shell',
        headers: { traceparent: TRACEPARENT },
        payload: { command: 'echo hi' },
      })
      expect(traced.statusCode, traced.body).toBe(200)
      const untraced = await app.inject({
        method: 'POST',
        url: '/v1/workspaces/traced/shell',
        payload: { command: 'echo hi' },
      })
      expect(untraced.statusCode, untraced.body).toBe(200)
    } finally {
      await app.close()
    }
    const [joined, alone] = spans.filter((s) => s.name === 'command')
    expect([joined?.parent?.traceId, joined?.parent?.spanId]).toEqual([TRACE_ID, PARENT_ID])
    expect(alone?.parent).toBeUndefined()
  })
})
