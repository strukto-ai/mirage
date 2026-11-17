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

import { describe, expect, it } from 'vitest'
import { traceHeaders } from './env.ts'

const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'

describe('traceHeaders', () => {
  // Twin of test_trace_headers_are_the_w3c_names_an_environment_holds.
  it('is the W3C names an environment holds', () => {
    const env = {
      TRACEPARENT,
      TRACESTATE: 'vendor=1',
      BAGGAGE: 'user=alice',
      PATH: '/usr/bin',
      traceparent: 'lowercase is not the carrier',
    }
    expect(traceHeaders(env)).toEqual({ traceparent: TRACEPARENT, tracestate: 'vendor=1' })
  })

  it('sends no header for an empty variable', () => {
    expect(traceHeaders({ TRACEPARENT: '' })).toEqual({})
  })
})
