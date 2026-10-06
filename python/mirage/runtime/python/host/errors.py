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

from mirage.errors import FsCondition, classify
from mirage.errors.posix import posix_errno, posix_phrase


def refused(condition: FsCondition, path: str) -> OSError:
    """The error a refused call raises on a mounted path.

    It carries the same condition every other mirage surface reports it
    with, so a guest sees one errno for one fact wherever it asked.

    Args:
        condition (FsCondition): what the refusal table says to answer.
        path (str): the mounted virtual path the call named.
    """
    return OSError(posix_errno(condition), posix_phrase(condition), path)


def numbered(exc: OSError) -> OSError:
    """`exc` as a real syscall raises it: errno, strerror and path set.

    A backend raises ``FileNotFoundError(path)`` with no errno, and
    pathlib reads the errno to tell a missing path from a broken one:
    ``Path.exists``, ``is_file`` and ``is_dir`` re-raise any OSError
    whose errno they do not recognize, so a plain ``if p.exists()``
    crashed on a missing mounted path. An error the vocabulary cannot
    name is returned as it came.

    Args:
        exc (OSError): what the door raised, errno set or not.
    """
    condition = classify(exc)
    if exc.errno is not None or condition is None:
        return exc
    path = exc.filename if exc.filename is not None else exc.args[0]
    return refused(condition, path)
