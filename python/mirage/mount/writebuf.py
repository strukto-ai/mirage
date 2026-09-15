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

import time


class WriteBuffer:
    """Pending writes per file id, merged and stored on drain.

    Two facts force this buffer. The server answers every WRITE as
    already durable and never forwards a COMMIT, so the adapter gets no
    signal about when a client is done; and a mirage backend stores
    whole objects, so writing each arriving chunk straight through would
    read and rewrite the entire file per chunk. Buffering turns a file
    copy from quadratic into one store.

    Writes are kept in arrival order and merged only on drain, which is
    what makes an out-of-order or overlapping sequence come out right: a
    later write to the same region wins because it is applied last. That
    case is not hypothetical -- a kernel client copying a megabyte
    through a mount was observed issuing writes that do not extend the
    file, which silently corrupts any implementation assuming
    append-only order.

    The cost is a window: a client is told its write is durable while
    the bytes are still here. The window is bounded by the idle sweep
    and by teardown, and it is the price of the server's fixed
    stability answer.

    Like ``IdTable``, every method is synchronous and await-free, so the
    event loop cannot interleave two of them and no lock is needed.
    """

    def __init__(self) -> None:
        self._writes: dict[int, list[tuple[int, bytes]]] = {}
        self._sizes: dict[int, int] = {}
        self._touched: dict[int, float] = {}

    @staticmethod
    def merge(base: bytes, writes: list[tuple[int, bytes]]) -> bytes:
        """Apply writes onto base in arrival order.

        Args:
            base (bytes): stored content the writes land on.
            writes (list[tuple[int, bytes]]): (offset, payload) pairs in
                the order the client sent them.

        Returns:
            bytes: the merged content, zero-filled across any gap.
        """
        merged = bytearray(base)
        for offset, payload in writes:
            end = offset + len(payload)
            if end > len(merged):
                merged.extend(b"\x00" * (end - len(merged)))
            merged[offset:end] = payload
        return bytes(merged)

    def append(self,
               fileid: int,
               offset: int,
               data: bytes,
               max_bytes: int | None = None,
               now: float | None = None) -> bool:
        """Buffer one write.

        Args:
            fileid (int): the file the write belongs to.
            offset (int): byte offset the client wrote at.
            data (bytes): the payload.
            max_bytes (int | None): ceiling past which the caller should
                drain; None leaves the buffer unbounded.
            now (float | None): timestamp to record, for tests.

        Returns:
            bool: True when the handle has reached ``max_bytes`` and the
            caller should drain it.
        """
        self._writes.setdefault(fileid, []).append((offset, bytes(data)))
        buffered = self._sizes.get(fileid, 0) + len(data)
        self._sizes[fileid] = buffered
        self._touched[fileid] = time.monotonic() if now is None else now
        return max_bytes is not None and buffered >= max_bytes

    def has_pending(self, fileid: int) -> bool:
        """Whether a file id holds unstored writes.

        Args:
            fileid (int): the file to check.
        """
        return bool(self._writes.get(fileid))

    def pending_ids(self) -> list[int]:
        """Every file id currently holding writes."""
        return [fileid for fileid, writes in self._writes.items() if writes]

    def idle_ids(self,
                 older_than: float,
                 now: float | None = None) -> list[int]:
        """File ids untouched for longer than ``older_than`` seconds.

        Args:
            older_than (float): idle threshold in seconds.
            now (float | None): timestamp to compare against, for tests.
        """
        moment = time.monotonic() if now is None else now
        return [
            fileid for fileid, touched in self._touched.items()
            if self._writes.get(fileid) and moment - touched > older_than
        ]

    def pending_size(self, fileid: int, base_size: int) -> int:
        """The size a client should see, counting unstored writes.

        A write that extends a file has already been acknowledged, so
        reporting the stored size would show the client a file that did
        not grow -- which reads as a failed write rather than a pending
        one.

        Args:
            fileid (int): the file being stat-ed.
            base_size (int): the stored size.

        Returns:
            int: the larger of the stored size and the furthest write.
        """
        pending = self._writes.get(fileid)
        if not pending:
            return base_size
        furthest = max(offset + len(data) for offset, data in pending)
        return max(base_size, furthest)

    def overlay(self, fileid: int, base: bytes, offset: int,
                size: int) -> bytes:
        """Read through pending writes.

        Without this, a read inside the flush window answers from stored
        content and misses writes the client has already been told
        succeeded.

        Args:
            fileid (int): the file being read.
            base (bytes): stored content.
            offset (int): where the read starts.
            size (int): how many bytes the client asked for.

        Returns:
            bytes: the requested slice, possibly short at end of file.
        """
        pending = self._writes.get(fileid)
        if not pending:
            return base[offset:offset + size]
        return self.merge(base, pending)[offset:offset + size]

    def clip(self, fileid: int, length: int) -> None:
        """Trim pending writes to a new file length.

        Called before a truncate. Left alone, a buffered write past the
        new end would be merged back in by the next drain and undo the
        truncate.

        Args:
            fileid (int): the file being truncated.
            length (int): the new length in bytes.
        """
        pending = self._writes.get(fileid)
        if not pending:
            return
        clipped: list[tuple[int, bytes]] = []
        total = 0
        for offset, data in pending:
            if offset >= length:
                continue
            kept = data[:length - offset]
            clipped.append((offset, kept))
            total += len(kept)
        if clipped:
            self._writes[fileid] = clipped
            self._sizes[fileid] = total
        else:
            self._forget(fileid)

    def drop(self, fileid: int) -> None:
        """Discard pending writes without storing them.

        What a removed file needs: storing the bytes would bring it back.

        Args:
            fileid (int): the file whose writes to discard.
        """
        self._forget(fileid)

    def take(self, fileid: int) -> list[tuple[int, bytes]]:
        """Remove and return a file's pending writes.

        The caller stores them, so the buffer hands them over rather
        than storing through a callback: the store is async and this
        class stays synchronous, which is what keeps it await-free.

        Args:
            fileid (int): the file to drain.

        Returns:
            list[tuple[int, bytes]]: pending writes in arrival order.
        """
        pending = self._writes.get(fileid, [])
        self._forget(fileid)
        return pending

    def total_bytes(self) -> int:
        """Bytes buffered across every file.

        The per-file ceiling bounds one handle; nothing bounded their
        sum, so N files written at once cost N times it. A caller that
        wants a global bound needs this number to compare against.

        Returns:
            int: total buffered bytes.
        """
        return sum(self._sizes.values())

    def heaviest_ids(self) -> list[int]:
        """Buffered files, largest first.

        The order a caller draining to a global ceiling wants: flushing
        the biggest buffer first reaches the ceiling in the fewest
        stores.

        Returns:
            list[int]: file ids holding pending writes, largest first.
        """
        return sorted(self._sizes, key=lambda i: self._sizes[i], reverse=True)

    def requeue(self, fileid: int, writes: list[tuple[int, bytes]]) -> None:
        """Put a taken batch back after its store failed.

        The client was told these writes were durable -- this server
        answers FILE_SYNC on every WRITE and is never sent a COMMIT --
        so a store that raised must not lose them. They go in *front*
        of anything buffered since: the buffer is arrival-ordered and
        later-wins, so appending an older batch would let it overwrite
        the newer bytes it is supposed to sit under.

        Args:
            fileid (int): the file whose batch to restore.
            writes (list[tuple[int, bytes]]): the batch ``take``
                returned. Empty is a no-op.
        """
        if not writes:
            return
        restored = [*writes, *self._writes.get(fileid, [])]
        self._writes[fileid] = restored
        self._sizes[fileid] = sum(len(data) for _, data in restored)
        # Only when nothing has been written since: a write that landed
        # during the failed store already stamped a newer time, and
        # moving it backwards would delay the retry.
        self._touched.setdefault(fileid, time.monotonic())

    def _forget(self, fileid: int) -> None:
        self._writes.pop(fileid, None)
        self._sizes.pop(fileid, None)
        self._touched.pop(fileid, None)
