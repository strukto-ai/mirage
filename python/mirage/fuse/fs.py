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

import asyncio
import errno
import os
import posixpath
import stat
import threading
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone

try:
    import mfusepy as fuse
except ImportError:
    fuse = None

from mirage.bridge.sync import run_async_from_sync
from mirage.fuse.platform.macos import is_macos_metadata
from mirage.ops import Ops
from mirage.types import FileStat, FileType

# "attribute not found" errno: ENOATTR on macOS, ENODATA on Linux.
_NO_XATTR = getattr(errno, "ENOATTR", None) or errno.ENODATA
# Base class only when mfusepy is installed; otherwise the module still imports
# (FUSE is the optional [fuse] extra) but instantiating MirageFS raises.
_FUSE_OPERATIONS = fuse.Operations if fuse is not None else object
# How long prefetched bytes for size-unknown files outlive their handle, so a
# release-then-stat burst (ls right after cat) neither refetches nor reports
# an unknown size. Mirrors the TS PREFETCH_TTL_MS.
PREFETCH_TTL = 30.0


@dataclass(slots=True)
class Handle:
    path: str
    data: bytes | None = None
    write_buf: list[tuple[int, bytes]] = field(default_factory=list)


class MirageFS(_FUSE_OPERATIONS):

    use_ns = True

    def __init__(self, ops: Ops, root_prefix: str = "") -> None:
        if fuse is None:
            raise RuntimeError(
                "FUSE support requires the 'fuse' extra: install "
                '"mirage-ai[fuse]" plus the OS driver (macFUSE, fuse3, or '
                "WinFsp). Setup and support matrix: "
                "https://mirage.dev/home/setup/fuse")
        self._ops = ops
        self._now = time.time_ns()
        self._root = root_prefix.rstrip("/")
        # When scoped to a single mount, the FUSE root maps onto that mount and
        # there are no virtual intermediate directories to synthesize.
        if self._root:
            self._prefixes = []
        else:
            self._prefixes = self._ops.mount_prefixes()
        self._handles: dict[int, Handle] = {}
        # Prefetched content for size-unknown files: path -> (data, expiry).
        self._prefetch: dict[str, tuple[bytes, float]] = {}
        # In-memory extended attributes, keyed by FUSE path. Backends have no
        # POSIX xattrs, so these are advisory, not persisted (see setxattr).
        self._xattrs: dict[str, dict[str, bytes]] = {}
        self._next_fh = 1
        # Windows has no getuid/getgid; the values are irrelevant there
        # because the mount passes uid=-1,gid=-1 and WinFsp presents files
        # as owned by the mounting user (see mount.py). Mirrors fs.ts.
        self._uid = os.getuid() if hasattr(os, "getuid") else 0
        self._gid = os.getgid() if hasattr(os, "getgid") else 0
        self._loop = asyncio.new_event_loop()
        self._loop_thread = threading.Thread(target=self._loop.run_forever,
                                             daemon=True)
        self._loop_thread.start()

    def _run(self, coro):
        return run_async_from_sync(coro, self._loop)

    def _resolve(self, path: str) -> str:
        """Map a FUSE path onto the workspace, honoring the mount root."""
        if not self._root:
            return path
        if path == "/":
            return self._root
        return self._root + path

    def _dir_stat(self) -> dict:
        return {
            "st_mode": stat.S_IFDIR | 0o755,
            "st_nlink": 2,
            "st_uid": self._uid,
            "st_gid": self._gid,
            "st_size": 0,
            "st_atime": self._now,
            "st_mtime": self._now,
            "st_ctime": self._now,
        }

    def _file_stat(self, size: int) -> dict:
        return {
            "st_mode": stat.S_IFREG | 0o644,
            "st_nlink": 1,
            "st_uid": self._uid,
            "st_gid": self._gid,
            "st_size": size,
            "st_atime": self._now,
            "st_mtime": self._now,
            "st_ctime": self._now,
        }

    def _apply_stat_attrs(self, entry: dict, s: FileStat) -> dict:
        """Fold merged stat attributes into a FUSE attr dict.

        The ops stat already carries the namespace overlay (chmod bits,
        chown ids, touched mtime), so honoring these fields here is what
        makes metadata ops visible over FUSE. String uid/gid (names) are
        skipped: FUSE wants numeric ids and there is no user db to map
        against.

        Args:
            entry (dict): base attr dict from _dir_stat/_file_stat.
            s (FileStat): the merged stat returned by the ops facade.
        """
        if s.mode is not None:
            entry["st_mode"] = (entry["st_mode"] & ~0o7777) | (s.mode & 0o7777)
        if isinstance(s.uid, int):
            entry["st_uid"] = s.uid
        if isinstance(s.gid, int):
            entry["st_gid"] = s.gid
        if s.modified is not None:
            try:
                ts = datetime.fromisoformat(s.modified)
            except ValueError:
                return entry
            if ts.tzinfo is None:
                ts = ts.replace(tzinfo=timezone.utc)
            ns = int(ts.timestamp()) * 1_000_000_000
            entry["st_mtime"] = ns
            entry["st_ctime"] = ns
        return entry

    def _link_target(self, path: str) -> str | None:
        """The target to present for a namespace link at a FUSE path.

        Relative targets are stored verbatim and returned as-is. Absolute
        targets name virtual paths, so they are rewritten relative to the
        link's directory: returned raw, the kernel would resolve them
        against the host root and escape the mountpoint.

        Args:
            path (str): FUSE path to inspect.

        Returns:
            str | None: displayable target, or None when not a link.
        """
        links = self._ops.links
        if links is None:
            return None
        target = links.readlink(self._resolve(path))
        if target is None:
            return None
        if not target.startswith("/"):
            return target
        fuse_target = target
        if self._root:
            if target == self._root:
                fuse_target = "/"
            elif target.startswith(self._root + "/"):
                fuse_target = target[len(self._root):]
            else:
                # points outside the scoped root: unreachable through this
                # mount, keep the stored form (a dangling link is legal)
                return target
        parent = path.rsplit("/", 1)[0] or "/"
        return posixpath.relpath(fuse_target, parent)

    def _link_stat(self, target: str) -> dict:
        entry = self._file_stat(len(target.encode()))
        entry["st_mode"] = stat.S_IFLNK | 0o777
        return entry

    def _is_virtual_dir(self, path: str) -> bool:
        normalized = path.rstrip("/") + "/"
        for p in self._prefixes:
            if p.startswith(normalized) or p.rstrip("/") == path.rstrip("/"):
                return True
        return False

    def _virtual_children(self, path: str) -> list[str]:
        normalized = path.rstrip("/") + "/" if path != "/" else "/"
        children = set()
        for p in self._prefixes:
            if p.startswith(normalized) and p != normalized:
                rest = p[len(normalized):]
                child = rest.split("/")[0]
                if child:
                    children.add(child)
        return sorted(children)

    def drain_ops(self) -> list[dict]:
        records = [asdict(r) for r in self._ops.records]
        self._ops.records.clear()
        return records

    def _cached_data(self, path: str) -> bytes | None:
        """Return prefetched bytes from open handles or the TTL cache.

        Args:
            path (str): FUSE path to look up.

        Returns:
            bytes | None: cached content, or None when nothing fresh is held.
        """
        for ctx in self._handles.values():
            if ctx.path == path and ctx.data is not None:
                return ctx.data
        entry = self._prefetch.get(path)
        if entry is None:
            return None
        data, expires = entry
        if time.monotonic() >= expires:
            del self._prefetch[path]
            return None
        return data

    def _cached_size(self, path: str) -> int | None:
        """Return the real size of prefetched data, if any is cached.

        Args:
            path (str): FUSE path to look up.

        Returns:
            int | None: byte length of cached content, or None.
        """
        data = self._cached_data(path)
        return len(data) if data is not None else None

    def _prefetch_read(self, path: str) -> bytes | None:
        """Fetch and cache the bytes of a size-unknown file.

        Args:
            path (str): FUSE path being opened.

        Returns:
            bytes | None: file content, or None when the backend read fails
            (open() stays permissive; the subsequent read() surfaces the
            error to the caller).
        """
        data = self._cached_data(path)
        if data is not None:
            return data
        try:
            data = self._run(self._ops.read(self._resolve(path)))
        except (FileNotFoundError, ValueError):
            return None
        # No inflight dedup: the mount runs nothreads=True, so FUSE callbacks
        # are serialized and two opens cannot race (TS needs the dedup map).
        self._prefetch[path] = (data, time.monotonic() + PREFETCH_TTL)
        return data

    def getattr(self, path: str, fh=None) -> dict:
        # fstat(fd) after open: answer with the hydrated handle's real byte
        # length. attr_timeout=0 on the mount makes the kernel actually ask
        # here instead of trusting the cached pre-open size, which is what
        # keeps wc -c, BSD cp, and tail -c correct for size-unknown files.
        if fh is not None:
            ctx = self._handles.get(fh)
            if ctx is not None and ctx.path == path and ctx.data is not None:
                return self._file_stat(len(ctx.data))
        if path == "/":
            return self._dir_stat()
        # macOS Finder/Spotlight probes .DS_Store, ._*, .Spotlight-V100, etc.
        # Reject early to avoid hitting the ops layer.
        name = path.rsplit("/", 1)[-1]
        if is_macos_metadata(name):
            raise fuse.FuseOSError(errno.ENOENT)
        # Link check must precede the ops stat: the ops facade follows
        # namespace links, so stat on a link path reports the target.
        target = self._link_target(path)
        if target is not None:
            return self._link_stat(target)
        if self._is_virtual_dir(path):
            return self._dir_stat()
        try:
            s = self._run(self._ops.stat(self._resolve(path)))
            if s.type == FileType.DIRECTORY:
                return self._apply_stat_attrs(self._dir_stat(), s)
            size = s.size
            if size is None:
                size = self._cached_size(path)
            if size is None:
                # Unopened size-unknown files stat as 0, matching mirage's own
                # find semantics. Reads stay correct anyway: direct_io makes
                # the kernel ignore st_size, and the fh branch above serves
                # the real size to fstat-based tools after open. Never report
                # a fake size and never fetch content here: getattr runs once
                # per entry on every ls -l.
                size = 0
            return self._apply_stat_attrs(self._file_stat(size), s)
        except (FileNotFoundError, ValueError):
            # unresolvable entry falls through to the canonical ENOENT below
            pass
        raise fuse.FuseOSError(errno.ENOENT)

    def readdir(self, path: str, fh) -> list:
        names = set(self._virtual_children(path))
        links = self._ops.links
        if links is not None:
            for link_name in links.links_under(self._resolve(path)):
                if link_name and not is_macos_metadata(link_name):
                    names.add(link_name)
        try:
            entries = self._run(self._ops.readdir(self._resolve(path)))
            for e in entries:
                part = e.rstrip("/").rsplit("/", 1)[-1]
                if part and not is_macos_metadata(part):
                    names.add(part)
        except (FileNotFoundError, ValueError):
            if not names:
                raise fuse.FuseOSError(errno.ENOENT)
        return [".", ".."] + sorted(names)

    def read(self, path: str, size: int, offset: int, fh) -> bytes:
        ctx = self._handles.get(fh)
        if ctx is not None and ctx.data is not None:
            return ctx.data[offset:offset + size]
        try:
            data = self._cached_data(path)
            if data is None:
                data = self._run(self._ops.read(self._resolve(path)))
            if ctx is not None:
                ctx.data = data
            return data[offset:offset + size]
        except (FileNotFoundError, ValueError):
            raise fuse.FuseOSError(errno.ENOENT)

    def write(self, path: str, data: bytes, offset: int, fh) -> int:
        ctx = self._handles.get(fh)
        if ctx is not None:
            ctx.write_buf.append((offset, data))
            return len(data)
        try:
            existing = b""
            try:
                existing = self._run(self._ops.read(self._resolve(path)))
            except FileNotFoundError:
                # missing file: start from empty and let the write create it
                pass
            if offset > len(existing):
                existing = existing + b"\0" * (offset - len(existing))
            new_data = existing[:offset] + data + existing[offset + len(data):]
            self._run(self._ops.write(self._resolve(path), new_data))
            self._prefetch.pop(path, None)
            return len(data)
        except PermissionError:
            raise fuse.FuseOSError(errno.EACCES)
        except ValueError:
            raise fuse.FuseOSError(errno.ENOENT)

    def create(self, path: str, mode, fi=None) -> int:
        try:
            self._run(self._ops.create(self._resolve(path)))
        except PermissionError:
            raise fuse.FuseOSError(errno.EACCES)
        except ValueError:
            raise fuse.FuseOSError(errno.ENOENT)
        self._prefetch.pop(path, None)
        fh = self._next_fh
        self._next_fh += 1
        self._handles[fh] = Handle(path=path)
        return fh

    def mkdir(self, path: str, mode) -> None:
        try:
            self._run(self._ops.mkdir(self._resolve(path)))
        except PermissionError:
            raise fuse.FuseOSError(errno.EACCES)
        except ValueError:
            raise fuse.FuseOSError(errno.ENOENT)

    def readlink(self, path: str) -> str:
        target = self._link_target(path)
        if target is None:
            raise fuse.FuseOSError(errno.EINVAL)
        return target

    def symlink(self, target: str, source: str) -> None:
        """Create namespace link ``target -> source`` (ln -s source target).

        Relative sources are stored verbatim (resolved at follow time,
        exactly like the shell ``ln -s``); absolute sources are mapped
        into virtual space so a scoped mount stores the path it will
        later follow.

        Args:
            target (str): FUSE path of the link being created.
            source (str): what the link points to, as typed.
        """
        links = self._ops.links
        if links is None:
            raise fuse.FuseOSError(errno.EROFS)
        stored = self._resolve(source) if source.startswith("/") else source
        self._run(links.symlink(self._resolve(target), stored, time.time()))

    def unlink(self, path: str) -> None:
        links = self._ops.links
        if links is not None and links.is_link(self._resolve(path)):
            self._run(links.unlink(self._resolve(path)))
            self._xattrs.pop(path, None)
            self._prefetch.pop(path, None)
            return
        try:
            self._run(self._ops.unlink(self._resolve(path)))
        except PermissionError:
            raise fuse.FuseOSError(errno.EACCES)
        except FileNotFoundError:
            raise fuse.FuseOSError(errno.ENOENT)
        self._xattrs.pop(path, None)
        self._prefetch.pop(path, None)

    def rename(self, old: str, new: str, flags: int = 0) -> None:
        try:
            self._run(self._ops.rename(self._resolve(old), self._resolve(new)))
        except PermissionError:
            raise fuse.FuseOSError(errno.EACCES)
        except (FileNotFoundError, ValueError):
            raise fuse.FuseOSError(errno.ENOENT)
        moved = self._xattrs.pop(old, None)
        if moved is not None:
            self._xattrs[new] = moved
        self._prefetch.pop(old, None)
        self._prefetch.pop(new, None)

    def rmdir(self, path: str) -> None:
        try:
            self._run(self._ops.rmdir(self._resolve(path)))
        except PermissionError:
            raise fuse.FuseOSError(errno.EACCES)
        except OSError:
            raise fuse.FuseOSError(errno.ENOTEMPTY)
        except (FileNotFoundError, ValueError):
            raise fuse.FuseOSError(errno.ENOENT)
        self._xattrs.pop(path, None)

    def statfs(self, path: str) -> dict:
        return {
            "f_bsize": 4096,
            "f_frsize": 4096,
            "f_blocks": 1024 * 1024,
            "f_bfree": 1024 * 1024,
            "f_bavail": 1024 * 1024,
            "f_files": 1000000,
            "f_ffree": 1000000,
            "f_favail": 1000000,
            "f_namemax": 255,
        }

    def chmod(self, path: str, mode) -> None:
        self.getattr(path)

    def chown(self, path: str, uid: int, gid: int) -> None:
        self.getattr(path)

    def utimens(self, path: str, times=None) -> None:
        self.getattr(path)

    def access(self, path: str, amode: int) -> None:
        self.getattr(path)

    def setxattr(self,
                 path: str,
                 name: str,
                 value: bytes,
                 options: int,
                 position: int = 0) -> int:
        # Mirage backends (S3, etc.) have no POSIX extended attributes, so
        # there is nothing to persist xattrs to. We keep them in memory per
        # mount so tools that probe or set xattrs (sandbox runtimes, rsync
        # -aX, tar --xattrs, cp -p, macOS Finder writing com.apple.*) succeed
        # instead of failing with ENOTSUP. The values live only for the
        # mount's lifetime and are intentionally not written to the backend.
        self.getattr(path)
        self._xattrs.setdefault(path, {})[name] = bytes(value)
        return 0

    def getxattr(self, path: str, name: str, position: int = 0) -> bytes:
        self.getattr(path)
        attrs = self._xattrs.get(path)
        if attrs is None or name not in attrs:
            raise fuse.FuseOSError(_NO_XATTR)
        return attrs[name]

    def listxattr(self, path: str) -> list[str]:
        self.getattr(path)
        return list(self._xattrs.get(path, {}).keys())

    def removexattr(self, path: str, name: str) -> int:
        self.getattr(path)
        self._xattrs.get(path, {}).pop(name, None)
        return 0

    def flush(self, path: str, fh) -> None:
        ctx = self._handles.get(fh)
        if ctx is not None:
            if not ctx.write_buf:
                return
            try:
                existing = b""
                try:
                    existing = self._run(self._ops.read(self._resolve(path)))
                except FileNotFoundError:
                    # missing file: start from empty; the write creates it
                    pass
                merged = bytearray(existing)
                for off, chunk in ctx.write_buf:
                    end = off + len(chunk)
                    if end > len(merged):
                        merged.extend(b"\0" * (end - len(merged)))
                    merged[off:off + len(chunk)] = chunk
                self._run(self._ops.write(self._resolve(path), bytes(merged)))
                ctx.write_buf = []
                self._prefetch.pop(path, None)
            except PermissionError:
                raise fuse.FuseOSError(errno.EACCES)
            return

    def fsync(self, path: str, datasync: int, fh) -> None:
        self.flush(path, fh)

    def open(self, path: str, flags) -> int:
        try:
            s = self._run(self._ops.stat(self._resolve(path)))
        except (FileNotFoundError, ValueError):
            raise fuse.FuseOSError(errno.ENOENT)
        ctx = Handle(path=path)
        if s.size is None and s.type != FileType.DIRECTORY:
            # API resources cannot size a file without fetching it, so hydrate
            # now: getattr(fh) and read() then serve real bytes, and the TTL
            # cache keeps release-then-stat bursts from refetching.
            ctx.data = self._prefetch_read(path)
        fh = self._next_fh
        self._next_fh += 1
        self._handles[fh] = ctx
        return fh

    def release(self, path: str, fh) -> int:
        self._handles.pop(fh, None)
        return 0

    def truncate(self, path: str, length: int, fh=None) -> None:
        try:
            self._run(self._ops.truncate(self._resolve(path), length))
        except PermissionError:
            raise fuse.FuseOSError(errno.EACCES)
        except ValueError:
            raise fuse.FuseOSError(errno.ENOENT)
        self._prefetch.pop(path, None)
