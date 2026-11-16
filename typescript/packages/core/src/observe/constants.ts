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

export const NAME_LIMIT = 200

export const TRACER_NAME = 'mirage.observe'

/**
 * Set to `false` or `0` to keep what calls touched out of spans: no output on
 * `shell`, no `vfs.<call>` spans. Named after OpenTelemetry's
 * `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`.
 */
export const TRACE_CONTENT_ENV = 'MIRAGE_TRACE_CAPTURE_CONTENT'

/**
 * How many bytes of each of a line's stdout and stderr its `shell` span
 * keeps: TRACE_CONTENT_MAX_BYTES unless this sets a positive whole number.
 * Named after Langfuse's `LANGFUSE_MAX_EVENT_SIZE_BYTES`.
 */
export const TRACE_CONTENT_MAX_BYTES_ENV = 'MIRAGE_TRACE_CONTENT_MAX_BYTES'

/**
 * 16 KiB a stream: both stay within half of the 64 KB a Cloudflare
 * Workers span holds for all its attributes, and any backend's field.
 */
export const TRACE_CONTENT_MAX_BYTES = 16 * 1024

// The most a workspace's RAM recorder holds. Past it the oldest lines go
// first, down to three quarters of it, so trimming stays rare however fast
// lines arrive: 8 MiB keeps thousands of lines with their calls.
export const RAM_LOG_BYTES = 8 * 1024 * 1024
