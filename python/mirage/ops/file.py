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
import io

from mirage.bridge.sync import run_async_from_sync
from mirage.ops import Ops


class MirageFile:

    def __init__(
        self,
        ops: Ops,
        path: str,
        mode: str = "r",
        loop: asyncio.AbstractEventLoop | None = None,
        **kwargs,
    ) -> None:
        self._ops = ops
        self._path = path
        self._mode = mode
        self._loop = loop
        self._encoding = kwargs.get("encoding", "utf-8")
        self._binary = "b" in mode
        self._closed = False
        self._buf: io.BytesIO | io.StringIO | None = None

    def _run(self, coro):
        return run_async_from_sync(coro, self._loop)

    def _load(self) -> None:
        if self._buf is not None:
            return
        if "w" in self._mode:
            if self._binary:
                self._buf = io.BytesIO()
            else:
                self._buf = io.StringIO()
            return
        if "a" in self._mode:
            try:
                data = self._run(self._ops.read(self._path))
            except FileNotFoundError:
                data = b""
            if self._binary:
                self._buf = io.BytesIO(data)
            else:
                self._buf = io.StringIO(data.decode(self._encoding))
            self._buf.seek(0, 2)
            return
        data = self._run(self._ops.read(self._path))
        if self._binary:
            self._buf = io.BytesIO(data)
        else:
            self._buf = io.StringIO(data.decode(self._encoding))

    @property
    def closed(self) -> bool:
        return self._closed

    @property
    def name(self) -> str:
        return self._path

    @property
    def mode(self) -> str:
        return self._mode

    def readable(self) -> bool:
        return "r" in self._mode

    def writable(self) -> bool:
        return "w" in self._mode or "a" in self._mode

    def read(self, size: int = -1) -> bytes | str:
        self._load()
        assert self._buf is not None
        return self._buf.read(size)

    def readline(self) -> bytes | str:
        self._load()
        assert self._buf is not None
        return self._buf.readline()

    def readlines(self) -> list:
        self._load()
        assert self._buf is not None
        return self._buf.readlines()

    def write(self, data) -> int:
        self._load()
        assert self._buf is not None
        return self._buf.write(data)

    def writelines(self, lines) -> None:
        self._load()
        assert self._buf is not None
        self._buf.writelines(lines)

    def seek(self, offset: int, whence: int = 0) -> int:
        self._load()
        assert self._buf is not None
        return self._buf.seek(offset, whence)

    def tell(self) -> int:
        self._load()
        assert self._buf is not None
        return self._buf.tell()

    def flush(self) -> None:
        pass

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        if "w" in self._mode or "a" in self._mode:
            if self._buf is not None:
                val = self._buf.getvalue()
                if isinstance(val, str):
                    val = val.encode(self._encoding)
                self._run(self._ops.write(self._path, val))

    def __del__(self) -> None:
        self.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    def __iter__(self):
        self._load()
        assert self._buf is not None
        return iter(self._buf)

    def __next__(self):
        self._load()
        assert self._buf is not None
        return next(self._buf)
