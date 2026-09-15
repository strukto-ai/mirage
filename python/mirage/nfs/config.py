# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

from dataclasses import dataclass

DEFAULT_PORT = 20490
DEFAULT_HOST = "127.0.0.1"
DEFAULT_IDLE_FLUSH_SECONDS = 5.0
DEFAULT_MAX_BUFFERED_BYTES = 16 * 1024 * 1024
# Four handles' worth. The per-handle ceiling bounds one file; without
# a sum, `cp -r` of many large files grows the process without limit.
DEFAULT_MAX_TOTAL_BUFFERED_BYTES = 64 * 1024 * 1024
DEFAULT_TIMEO_DECISECONDS = 50
DEFAULT_RETRANS = 3
DEFAULT_DEAD_TIMEOUT_SECONDS = 60


@dataclass(frozen=True, slots=True)
class NFSConfig:
    """Knobs for one NFS-backed mount.

    Args:
        host (str): address the server binds. Loopback only by default:
            an NFSv3 export has no authentication of its own, so binding
            anywhere reachable would publish the workspace unguarded.
        port (int): TCP port serving both the MOUNT and NFS programs, so
            no portmapper is needed. 0 asks the OS for a free port.
        idle_flush_seconds (float): how long a handle's buffered writes
            may sit before the adapter flushes them. NFSv3 gives the
            adapter no COMMIT signal through this server, so this bounds
            the window in which a crash loses acknowledged writes.
        max_buffered_bytes (int): per-handle ceiling that forces an early
            flush, so a client that never stops writing cannot grow the
            buffer without bound.
        max_total_buffered_bytes (int): ceiling across every handle. The
            per-handle one bounds a single file, so N files written at
            once cost N times it and a `cp -r` of many large files grew
            the process without limit; past this the adapter drains its
            biggest buffers until it is back under.
        soft (bool): mount soft rather than the platform default, hard.
            A hard mount blocks every I/O forever when the server stops
            answering, uninterruptibly, and on macOS that wedges anything
            that walks the mount table -- Finder, df, Spotlight -- not
            just the caller. The server here is this very process, so a
            deadlock in it is exactly the case that would freeze the host
            that started it. False is honest for a deployment that would
            rather wait out a slow server than see EIO, and it is only
            safe when something else can force the unmount.
        timeo (int): initial retransmit timeout in TENTHS of a second,
            the unit both mount_nfs and mount.nfs read.
        retrans (int): retransmits before a soft mount gives up. With
            timeo, this bounds a stalled I/O at roughly
            ``timeo * retrans`` tenths of a second.
        dead_timeout (int): seconds a mount may stay unresponsive before
            the kernel forcibly unmounts it. Darwin only, and 0 disables
            it -- the last line of defence when the server dies without
            unmounting, which is what leaves a wedged mountpoint behind.
    """

    host: str = DEFAULT_HOST
    port: int = DEFAULT_PORT
    idle_flush_seconds: float = DEFAULT_IDLE_FLUSH_SECONDS
    max_buffered_bytes: int = DEFAULT_MAX_BUFFERED_BYTES
    max_total_buffered_bytes: int = DEFAULT_MAX_TOTAL_BUFFERED_BYTES
    soft: bool = True
    timeo: int = DEFAULT_TIMEO_DECISECONDS
    retrans: int = DEFAULT_RETRANS
    dead_timeout: int = DEFAULT_DEAD_TIMEOUT_SECONDS

    def __post_init__(self) -> None:
        if not 0 <= self.port <= 65535:
            raise ValueError(f"port out of range: {self.port}")
        if self.idle_flush_seconds <= 0:
            raise ValueError("idle_flush_seconds must be positive: "
                             f"{self.idle_flush_seconds}")
        if self.max_buffered_bytes <= 0:
            raise ValueError("max_buffered_bytes must be positive: "
                             f"{self.max_buffered_bytes}")
        if self.max_total_buffered_bytes < self.max_buffered_bytes:
            raise ValueError(
                "max_total_buffered_bytes must be at least "
                f"max_buffered_bytes: {self.max_total_buffered_bytes} < "
                f"{self.max_buffered_bytes}")
        if self.timeo <= 0:
            raise ValueError(f"timeo must be positive: {self.timeo}")
        if self.retrans <= 0:
            raise ValueError(f"retrans must be positive: {self.retrans}")
        if self.dead_timeout < 0:
            raise ValueError("dead_timeout must not be negative: "
                             f"{self.dead_timeout}")
