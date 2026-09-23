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

/** Capture unresolved program names without taking over the workspace shell. */
export const EXTERNAL_COMMANDS = '@external'

/**
 * The most per-entry requests a runtime keeps in flight.
 *
 * Classifying or preloading an entry is a request of its own on a
 * mount that keeps no listing index, so an unbounded listing puts a
 * whole directory's worth of requests on the wire together. The door's
 * classifying stats share one such cap, and so does a preload walk.
 * Python works one entry at a time and needs no bound.
 */
export const LISTING_ENTRY_CONCURRENCY = 16
