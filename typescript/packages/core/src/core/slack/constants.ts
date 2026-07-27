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
 * Slack has no size API, so du must walk. The tree is a directory per
 * conversation per day (90 days deep), and every uncached day costs a
 * conversations.history call against a ~50/minute rate limit, so an unbounded
 * walk of a real workspace runs for hours. Far below the generic cap for that
 * reason.
 */
export const DU_MAX_ENTRIES = 500
