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
 * The runtime argument, policy, or a script could not decide the line.
 * Caller-fixable routing mistakes (unknown runtime name, a script that does not parse, a
 * missing monty package) propagate loud instead of folding into the
 * line's IOResult like a command failure.
 */
export class PolicyError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'PolicyError'
  }
}

/**
 * The policy refused the line before anything ran.
 *
 * A legitimate policy outcome, not a mistake: execute() folds it into
 * the line's result (exit 126, the reason on stderr) instead of
 * propagating like PolicyError.
 */
export class PolicyDeny extends Error {
  constructor(readonly reason: string) {
    super(reason)
    this.name = 'PolicyDeny'
  }
}
