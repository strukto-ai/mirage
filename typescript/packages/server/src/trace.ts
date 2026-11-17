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

import { context, isSpanContextValid, propagation, trace, type Context } from '@opentelemetry/api'
import type { FastifyReply, FastifyRequest, HookHandlerDoneFunction } from 'fastify'

/**
 * The context a request runs under, so the spans of the lines it starts
 * join the caller's trace. A span already open for it, as an
 * instrumentation library opens one under the caller's, is kept;
 * otherwise the caller's span comes from `headers` through the process's
 * propagator (W3C `traceparent` under the OpenTelemetry SDK's default). A
 * request that names none starts no trace.
 */
export function requestContext(
  headers: Readonly<Record<string, string | string[] | undefined>>,
): Context {
  const current = context.active()
  const open = trace.getSpanContext(current)
  if (open !== undefined && isSpanContextValid(open)) return current
  return propagation.extract(current, headers)
}

/**
 * Run each request's handler under `requestContext`, as a `preHandler`
 * hook: after its body is read, whose stream events would lose it.
 */
export function traceContextMiddleware(
  request: FastifyRequest,
  _reply: FastifyReply,
  done: HookHandlerDoneFunction,
): void {
  context.with(requestContext(request.headers), done)
}
