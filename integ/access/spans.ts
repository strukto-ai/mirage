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

import { appendFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import {
  context,
  isSpanContextValid,
  propagation,
  trace,
  type Attributes,
  type AttributeValue,
  type Context,
  type Span,
  type SpanContext,
  type SpanOptions,
  type Tracer,
} from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { W3CTraceContextPropagator } from '@opentelemetry/core'

export const SPANS_ENV = 'ACCESS_SPANS'

/**
 * Send every span this process starts to `path`, one JSON line as each
 * ends, with its name, ids, parent and `mirage.command`; the twin of
 * `spans.py`. The process gets the context manager and W3C propagator an
 * OpenTelemetry SDK registers, so a caller's trace reaches its lines.
 */
export function recordSpans(path: string): void {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())
  propagation.setGlobalPropagator(new W3CTraceContextPropagator())
  const tracer = {
    startSpan(name: string, options: SpanOptions = {}, ctx: Context = context.active()): Span {
      const found = trace.getSpanContext(ctx)
      const parent = found !== undefined && isSpanContextValid(found) ? found : undefined
      const own: SpanContext = {
        traceId: parent?.traceId ?? randomBytes(16).toString('hex'),
        spanId: randomBytes(8).toString('hex'),
        traceFlags: 1,
      }
      const attributes: Attributes = { ...options.attributes }
      const span = {
        spanContext: () => own,
        isRecording: () => true,
        setAttribute: (key: string, value: AttributeValue) => {
          attributes[key] = value
          return span
        },
        setAttributes: (more: Attributes) => {
          Object.assign(attributes, more)
          return span
        },
        addEvent: () => span,
        addLink: () => span,
        addLinks: () => span,
        setStatus: () => span,
        updateName: () => span,
        recordException: () => undefined,
        end: () => {
          const record = {
            name,
            trace_id: own.traceId,
            span_id: own.spanId,
            parent_id: parent?.spanId ?? null,
            command: attributes['mirage.command'] ?? null,
          }
          appendFileSync(path, JSON.stringify(record) + '\n')
        },
      }
      return span as unknown as Span
    },
  }
  trace.setGlobalTracerProvider({ getTracer: () => tracer as unknown as Tracer })
}
