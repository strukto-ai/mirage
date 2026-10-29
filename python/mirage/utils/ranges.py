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


@dataclass(frozen=True, slots=True)
class ByteWindow:
    """A byte window, as every HTTP-backed reader takes one.

    The pair travels together because a store that sends a ``Range`` has
    to check the answer against the same two numbers, so a helper handed
    only the rendered header cannot finish the job.
    """

    offset: int
    size: int | None


def window_for(offset: int, size: int | None) -> ByteWindow | None:
    """The window a reader was asked for, or None when it wants all of it.

    Args:
        offset (int): first byte to read.
        size (int | None): how many bytes, or None for the rest.
    """
    if not offset and size is None:
        return None
    return ByteWindow(offset, size)


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
    return data[offset : None if size is None else offset + size]


def splice_window(data: bytes, offset: int, payload: bytes) -> bytes:
    """Bytes in hand with ``payload`` written at ``offset``, as pwrite(2)
    leaves a file.

    The answer when nothing remote can write a range: what lies before
    and after the window stays, and a gap past the end reads as zeros.
    Writing nothing changes nothing, even past the end.

    Args:
        data (bytes): the whole content.
        offset (int): first byte the payload replaces.
        payload (bytes): the bytes written there.
    """
    if not payload:
        return data
    head = data[:offset].ljust(offset, b"\0")
    return head + payload + data[offset + len(payload) :]


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

    A reader that seeks rather than sending a header (OpenDAL's file
    object, which hf and nextcloud both open) raises an OSError from the
    seek itself instead of surfacing a status. It is the same condition,
    so it is matched here rather than guarded in each of those backends.

    Args:
        exc (BaseException): whatever the backend reader raised.
    """
    if _status_of(exc) == 416:
        return True
    if _code_of(exc) in ("InvalidRange", "RequestedRangeNotSatisfiable"):
        return True
    text = str(exc).lower()
    if "range not satisfiable" in text:
        return True
    # OpenDAL reports the store's whole response as message text rather
    # than fields, so a WebDAV 416 arrives as SabreDAV's exception name
    # and wording with the status only readable inside the string.
    if "requestedrangenotsatisfiable" in text:
        return True
    if "exceeded the size of the entity" in text:
        return True
    # Asked for a window past the end, huggingface echoes a Content-Range
    # whose end precedes its start (``bytes 99-2/3`` for a 3-byte file)
    # and OpenDAL refuses to parse it rather than reporting a status.
    if "content range is invalid" in text and "end is less than start" in text:
        return True
    return "seek" in text and "beyond the end" in text
