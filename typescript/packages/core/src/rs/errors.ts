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

/**
 * A failure after the command had already written `output`: a mirage-rs
 * stream that refused its input, or a CLI leaf that prints as it goes
 * (`gh --jq`), whose output stays on stdout ahead of the diagnostic.
 * `message` is the refusal, without a newline: the command's stderr wording,
 * or what the caller reports it as (`sort -c` gets the disordered record's
 * number). Mirrors Python's StreamRefusal.
 */
export class StreamRefusal extends Error {
  readonly output: Uint8Array

  constructor(message: string, output: Uint8Array) {
    super(message)
    this.name = 'StreamRefusal'
    this.output = output
  }
}

/**
 * A -P line search gave up at PCRE2's match limit: `message` in GNU grep's
 * words, `spans` the matches -o found on the line before it. Mirrors
 * Python's SearchLimit.
 */
export class SearchLimit extends Error {
  readonly spans: [number, number][]

  constructor(message: string, spans: [number, number][]) {
    super(message)
    this.name = 'SearchLimit'
    this.spans = spans
  }
}

/**
 * A pattern mirage-rs refused to compile. `message` is the refusal as the
 * program words it, without its `prog: ` prefix (`Unmatched ( or \(`).
 * Mirrors Python's RegexError.
 */
export class RegexError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RegexError'
  }
}
