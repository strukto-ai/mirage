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


def range_header(offset: int, size: int | None) -> str | None:
    """An HTTP ``Range`` value for a byte window, or None for the whole file.

    Every HTTP-backed store spells a partial read the same way, so the
    spelling lives here rather than once per backend. ``None`` means the
    caller wants everything and should send no header at all.

    A zero-length window has no HTTP spelling: ``bytes=N--1`` is
    malformed and an absent header means the opposite of what was asked.
    It is refused here so a caller that forgot to short-circuit finds out
    rather than silently downloading the whole object.

    Args:
        offset (int): first byte to read.
        size (int | None): how many bytes, or None for the rest of the file.
    """
    if offset < 0:
        raise ValueError(f"range offset must be non-negative: {offset}")
    if size is not None and size < 0:
        raise ValueError(f"range size must be non-negative: {size}")
    if size == 0:
        raise ValueError("a zero-length range has no HTTP spelling")
    if not offset and size is None:
        return None
    end = "" if size is None else offset + size - 1
    return f"bytes={offset}-{end}"


def slice_window(data: bytes, offset: int, size: int | None) -> bytes:
    """The requested window out of bytes already in hand.

    The answer when nothing remote can serve a range: a store that
    renders its content, or one whose reader has no range support.

    Args:
        data (bytes): the whole content.
        offset (int): first byte to keep.
        size (int | None): how many bytes, or None for the rest.
    """
    return data[offset:None if size is None else offset + size]


def _status_of(exc: BaseException) -> int | None:
    """The HTTP status an exception carries, across the client libraries.

    botocore stamps it into ``response["ResponseMetadata"]``, aiohttp onto
    ``.status``, httpx onto ``.response.status_code``. None of them share a
    base class, so the shapes are read rather than the types matched.

    Args:
        exc (BaseException): whatever the backend reader raised.
    """
    response = getattr(exc, "response", None)
    if isinstance(response, dict):
        meta = response.get("ResponseMetadata")
        if isinstance(meta, dict):
            status = meta.get("HTTPStatusCode")
            if isinstance(status, int):
                return status
    inner = getattr(response, "status_code", None)
    if isinstance(inner, int):
        return inner
    for attr in ("status", "status_code"):
        status = getattr(exc, attr, None)
        if isinstance(status, int):
            return status
    return None


def _code_of(exc: BaseException) -> str | None:
    response = getattr(exc, "response", None)
    if isinstance(response, dict):
        error = response.get("Error")
        if isinstance(error, dict):
            code = error.get("Code")
            if isinstance(code, str):
                return code
    code = getattr(exc, "code", None)
    return code if isinstance(code, str) else None


def is_unsatisfiable_range(exc: BaseException) -> bool:
    """Whether an error means the window starts past the end of the object.

    A POSIX read at or past EOF returns zero bytes; an HTTP store answers
    416 instead, and every backend spells the refusal differently. The
    predicate lives here so the ops factory can turn all of them into the
    empty read the caller expects, rather than each backend re-deciding.

    Args:
        exc (BaseException): whatever the backend reader raised.
    """
    if _status_of(exc) == 416:
        return True
    if _code_of(exc) in ("InvalidRange", "RequestedRangeNotSatisfiable"):
        return True
    return "range not satisfiable" in str(exc).lower()
