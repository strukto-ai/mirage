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

import errno

from mirage.errors.constants import CLASS_ARMS, ERRNO_ARMS
from mirage.errors.types import FsCondition


def classify(exc: BaseException) -> FsCondition | None:
    """Name the condition an exception reports, if the vocabulary names one.

    The one classifier: every boundary (FUSE/FSKit adapters, the wasi
    host, the monty encoders) calls this and then renders the condition
    through its own number table. None means "no named condition", and
    the caller keeps its own fallback (FUSE passes a raw OSError errno
    through to the kernel, the wasi host answers EIO/EINVAL), because a
    number outside the vocabulary is a passthrough, not a translation.

    Args:
        exc (BaseException): the exception a mount, the namespace, or a
            policy raised.
    """
    if isinstance(exc, PermissionError) and exc.errno == errno.EPERM:
        # CPython constructs OSError(EPERM, ...) AS a PermissionError,
        # the same subclass EACCES gets, so the one class carries two
        # conditions and only the errno tells them apart.
        return FsCondition.EPERM
    for exc_type, condition in CLASS_ARMS:
        if isinstance(exc, exc_type):
            return condition
    if isinstance(exc, OSError) and exc.errno:
        return ERRNO_ARMS.get(exc.errno)
    return None
