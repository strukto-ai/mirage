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
import stat
import threading
import time
import uuid
from dataclasses import asdict

import mfusepy as fuse

from mirage.bridge.sync import run_async_from_sync
from mirage.fuse.platform.macos import is_macos_metadata
from mirage.ops import Ops
from mirage.types import FileType

_ENV_AGENT_ID = "MIRAGE_AGENT_ID"
_MIRAGE_DIR = "/.mirage"
_MIRAGE_WHOAMI = "/.mirage/whoami"
# "attribute not found" errno: ENOATTR on macOS, ENODATA on Linux.
_NO_XATTR = getattr(errno, "ENOATTR", None) or errno.ENODATA


class MirageFS(fuse.Operations):

    use_ns = True

    def __init__(self,
                 ws_or_ops,
                 agent_id: str | None = None,
                 root_prefix: str = "") -> None:
        if isinstance(ws_or_ops, Ops):
            self._ops = ws_or_ops
            self.ws = None
        else:
            self.ws = ws_or_ops
            self._ops = ws_or_ops.ops
        self.agent_id = (agent_id or os.environ.get(_ENV_AGENT_ID)
                         or f"agent-{uuid.uuid4().hex[:8]}")
        self._now = time.time_ns()
        self._root = root_prefix.rstrip("/")
        # When scoped to a single mount, the FUSE root maps onto that mount and
        # there are no virtual intermediate directories to synthesize.
        if self._root:
            self._prefixes = []
        else:
            self._prefixes = [m.prefix for m in self._ops._mounts]
        self._handles: dict[int, dict] = {}
        # In-memory extended attributes, keyed by FUSE path. Backends have no
        # POSIX xattrs, so these are advisory, not persisted (see setxattr).
        self._xattrs: dict[str, dict[str, bytes]] = {}
        self._next_fh = 1
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

    def _whoami_content(self) -> bytes:
        mounts = [m.prefix for m in self._ops._mounts]
        lines = [
            f"agent: {self.agent_id}",
            "cwd: /",
            f"mounts: {', '.join(mounts)}",
        ]
        return ("\n".join(lines) + "\n").encode()

    def _dir_stat(self) -> dict:
        return {
            "st_mode": stat.S_IFDIR | 0o755,
            "st_nlink": 2,
            "st_uid": os.getuid(),
            "st_gid": os.getgid(),
            "st_size": 0,
            "st_atime": self._now,
            "st_mtime": self._now,
            "st_ctime": self._now,
        }

    def _file_stat(self, size: int) -> dict:
        return {
            "st_mode": stat.S_IFREG | 0o644,
            "st_nlink": 1,
            "st_uid": os.getuid(),
            "st_gid": os.getgid(),
            "st_size": size,
            "st_atime": self._now,
            "st_mtime": self._now,
            "st_ctime": self._now,
        }

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

    def _cached_size(self, path: str) -> int | None:
        """Return real size from prefetched data in open handles."""
        for ctx in self._handles.values():
            if ctx.get("path") == path and "data" in ctx:
                return len(ctx["data"])
        return None

    def getattr(self, path: str, fh=None) -> dict:
        if path == "/":
            return self._dir_stat()
        if path == _MIRAGE_DIR:
            return self._dir_stat()
        if path == _MIRAGE_WHOAMI:
            return self._file_stat(len(self._whoami_content()))
        # macOS Finder/Spotlight probes .DS_Store, ._*, .Spotlight-V100, etc.
        # Reject early to avoid hitting the ops layer.
        name = path.rsplit("/", 1)[-1]
        if is_macos_metadata(name):
            raise fuse.FuseOSError(errno.ENOENT)
        if self._is_virtual_dir(path):
            return self._dir_stat()
        try:
            s = self._run(self._ops.stat(self._resolve(path)))
            if s.type == FileType.DIRECTORY:
                return self._dir_stat()
            size = s.size
            if size is None:
                size = self._cached_size(path)
            if size is None:
                size = 0
            return self._file_stat(size)
        except (FileNotFoundError, ValueError):
            pass
        raise fuse.FuseOSError(errno.ENOENT)

    def readdir(self, path: str, fh) -> list:
        if path == _MIRAGE_DIR:
            return [".", "..", "whoami"]
        names = set(self._virtual_children(path))
        if path == "/":
            names.add(".mirage")
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
        if path == _MIRAGE_WHOAMI:
            data = self._whoami_content()
            return data[offset:offset + size]
        ctx = self._handles.get(fh, {})
        try:
            if "data" not in ctx:
                ctx["data"] = self._run(self._ops.read(self._resolve(path)))
            return ctx["data"][offset:offset + size]
        except (FileNotFoundError, ValueError):
            raise fuse.FuseOSError(errno.ENOENT)

    def write(self, path: str, data: bytes, offset: int, fh) -> int:
        ctx = self._handles.get(fh)
        if ctx is not None:
            try:
                buf = ctx.setdefault("write_buf", [])
                buf.append((offset, data))
                return len(data)
            except PermissionError:
                raise fuse.FuseOSError(errno.EACCES)
        try:
            existing = b""
            try:
                existing = self._run(self._ops.read(self._resolve(path)))
            except FileNotFoundError:
                pass
            if offset > len(existing):
                existing = existing + b"\0" * (offset - len(existing))
            new_data = existing[:offset] + data + existing[offset + len(data):]
            self._run(self._ops.write(self._resolve(path), new_data))
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
        ctx = {"path": path}
        fh = self._next_fh
        self._next_fh += 1
        self._handles[fh] = ctx
        return fh

    def mkdir(self, path: str, mode) -> None:
        try:
            self._run(self._ops.mkdir(self._resolve(path)))
        except PermissionError:
            raise fuse.FuseOSError(errno.EACCES)
        except ValueError:
            raise fuse.FuseOSError(errno.ENOENT)

    def unlink(self, path: str) -> None:
        try:
            self._run(self._ops.unlink(self._resolve(path)))
        except PermissionError:
            raise fuse.FuseOSError(errno.EACCES)
        except FileNotFoundError:
            raise fuse.FuseOSError(errno.ENOENT)
        self._xattrs.pop(path, None)

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
            buf = ctx.get("write_buf")
            if not buf:
                return
            try:
                existing = b""
                try:
                    existing = self._run(self._ops.read(self._resolve(path)))
                except FileNotFoundError:
                    pass
                merged = bytearray(existing)
                for off, chunk in buf:
                    end = off + len(chunk)
                    if end > len(merged):
                        merged.extend(b"\0" * (end - len(merged)))
                    merged[off:off + len(chunk)] = chunk
                self._run(self._ops.write(self._resolve(path), bytes(merged)))
                ctx["write_buf"] = []
            except PermissionError:
                raise fuse.FuseOSError(errno.EACCES)
            return

    def fsync(self, path: str, datasync: int, fh) -> None:
        self.flush(path, fh)

    def open(self, path: str, flags) -> int:
        if path == _MIRAGE_WHOAMI:
            fh = self._next_fh
            self._next_fh += 1
            self._handles[fh] = {"path": path}
            return fh
        try:
            s = self._run(self._ops.stat(self._resolve(path)))
        except (FileNotFoundError, ValueError):
            raise fuse.FuseOSError(errno.ENOENT)
        ctx = {"path": path}
        if s.size is None and s.type != FileType.DIRECTORY:
            # Prefetch: API resources don't report size, so fetch content
            # now. getattr() will find the cached data and return real size,
            # allowing cat/read to exit cleanly instead of waiting for 1GB.
            try:
                ctx["data"] = self._run(self._ops.read(self._resolve(path)))
            except (FileNotFoundError, ValueError):
                pass
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
