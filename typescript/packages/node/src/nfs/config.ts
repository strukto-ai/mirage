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

export const DEFAULT_PORT = 20490
export const DEFAULT_HOST = '127.0.0.1'
export const DEFAULT_IDLE_FLUSH_SECONDS = 5.0
export const DEFAULT_MAX_BUFFERED_BYTES = 16 * 1024 * 1024
// Four handles' worth. The per-handle ceiling bounds one file;
// without a sum, `cp -r` of many large files grows the process
// without limit.
const DEFAULT_MAX_TOTAL_BUFFERED_BYTES = 64 * 1024 * 1024
const DEFAULT_TIMEO_DECISECONDS = 50
const DEFAULT_RETRANS = 3
const DEFAULT_DEAD_TIMEOUT_SECONDS = 60

/** Knobs for one NFS-backed mount. */
export interface NFSConfigInit {
  /**
   * Address the server binds. Loopback only by default: an NFSv3
   * export has no authentication of its own, so binding anywhere
   * reachable would publish the workspace unguarded.
   */
  host?: string
  /**
   * TCP port serving both the MOUNT and NFS programs, so no
   * portmapper is needed. 0 asks the OS for a free port.
   */
  port?: number
  /**
   * How long a handle's buffered writes may sit before the adapter
   * flushes them. The server answers every write as durable and
   * forwards no COMMIT, so this bounds the window in which a crash
   * loses acknowledged writes.
   */
  idleFlushSeconds?: number
  /**
   * Per-handle ceiling that forces an early flush, so a client that
   * never stops writing cannot grow the buffer without bound.
   */
  maxBufferedBytes?: number
  maxTotalBufferedBytes?: number
  /**
   * Mount soft rather than the platform default, hard. A hard mount
   * blocks every I/O forever when the server stops answering,
   * uninterruptibly, and on macOS that wedges anything that walks the
   * mount table -- Finder, df, Spotlight -- not just the caller. The
   * server here is this very process, so a deadlock in it is exactly
   * the case that would freeze the host that started it. False is
   * honest for a deployment that would rather wait out a slow server
   * than see EIO, and it is only safe when something else can force
   * the unmount.
   */
  soft?: boolean
  /**
   * Initial retransmit timeout in TENTHS of a second, the unit both
   * mount_nfs and mount.nfs read.
   */
  timeo?: number
  /**
   * Retransmits before a soft mount gives up. With `timeo`, this bounds
   * a stalled I/O at roughly `timeo * retrans` tenths of a second.
   */
  retrans?: number
  /**
   * Seconds a mount may stay unresponsive before the kernel forcibly
   * unmounts it. Darwin only, and 0 disables it -- the last line of
   * defence when the server dies without unmounting, which is what
   * leaves a wedged mountpoint behind.
   */
  deadTimeout?: number
}

export class NFSConfig {
  readonly host: string
  readonly port: number
  readonly idleFlushSeconds: number
  readonly maxBufferedBytes: number
  readonly maxTotalBufferedBytes: number
  readonly soft: boolean
  readonly timeo: number
  readonly retrans: number
  readonly deadTimeout: number

  constructor(init: NFSConfigInit = {}) {
    this.host = init.host ?? DEFAULT_HOST
    this.port = init.port ?? DEFAULT_PORT
    this.idleFlushSeconds = init.idleFlushSeconds ?? DEFAULT_IDLE_FLUSH_SECONDS
    this.maxBufferedBytes = init.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES
    this.maxTotalBufferedBytes = init.maxTotalBufferedBytes ?? DEFAULT_MAX_TOTAL_BUFFERED_BYTES
    this.soft = init.soft ?? true
    this.timeo = init.timeo ?? DEFAULT_TIMEO_DECISECONDS
    this.retrans = init.retrans ?? DEFAULT_RETRANS
    this.deadTimeout = init.deadTimeout ?? DEFAULT_DEAD_TIMEOUT_SECONDS
    if (!Number.isInteger(this.port) || this.port < 0 || this.port > 65535) {
      throw new RangeError(`port out of range: ${String(this.port)}`)
    }
    if (this.idleFlushSeconds <= 0) {
      throw new RangeError(`idleFlushSeconds must be positive: ${String(this.idleFlushSeconds)}`)
    }
    if (this.maxTotalBufferedBytes < this.maxBufferedBytes) {
      throw new RangeError(
        `maxTotalBufferedBytes must be at least maxBufferedBytes: ` +
          `${String(this.maxTotalBufferedBytes)} < ${String(this.maxBufferedBytes)}`,
      )
    }
    if (this.maxBufferedBytes <= 0) {
      throw new RangeError(`maxBufferedBytes must be positive: ${String(this.maxBufferedBytes)}`)
    }
    if (this.timeo <= 0) {
      throw new RangeError(`timeo must be positive: ${String(this.timeo)}`)
    }
    if (this.retrans <= 0) {
      throw new RangeError(`retrans must be positive: ${String(this.retrans)}`)
    }
    if (this.deadTimeout < 0) {
      throw new RangeError(`deadTimeout must not be negative: ${String(this.deadTimeout)}`)
    }
    // The twin of python's frozen dataclass, the way core's stat rows are
    // frozen: the server is started from these values, so a later write
    // would describe a server that is not running.
    Object.freeze(this)
  }
}
