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

export const TICK_MS = 1000

export interface ClockState {
  baseMs: number
  ticks: number
}

// Frozen at construction (i.e. per /reset) so `find -mtime` windows relative to
// "now" behave like a live backend, while the +1s tick per touch keeps ordering
// deterministic. /reset may pin an explicit epoch instead: mounts that render
// timestamps into filenames need fully baked-in listings.
export class Clock {
  private baseMs: number
  private ticks = 0

  constructor(epoch?: string) {
    this.baseMs = epoch === undefined ? Date.now() : Date.parse(epoch)
  }

  setEpoch(epoch?: string): void {
    this.baseMs = epoch === undefined ? Date.now() : Date.parse(epoch)
    this.ticks = 0
  }

  // What a run's snapshot keeps of the clock, and what loading it puts back:
  // the next tick after a load is the one the snapshot would have handed out.
  snapshot(): ClockState {
    return { baseMs: this.baseMs, ticks: this.ticks }
  }

  load(state: ClockState): void {
    this.baseMs = state.baseMs
    this.ticks = state.ticks
  }

  nowMs(): number {
    this.ticks += 1
    return this.baseMs + this.ticks * TICK_MS
  }

  nowIso(millis = true): string {
    return iso(this.nowMs(), millis)
  }

  // The stamp the latest tick handed out, without ticking: for a record that
  // has to sort after the writes before it, where another tick would move
  // every later timestamp a fixture or golden already pins.
  lastIso(millis = true): string {
    return iso(this.baseMs + this.ticks * TICK_MS, millis)
  }
}

function iso(ms: number, millis: boolean): string {
  const d = new Date(ms)
  return millis ? d.toISOString() : d.toISOString().replace(/\.\d{3}Z$/, 'Z')
}
