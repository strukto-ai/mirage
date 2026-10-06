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

from mirage.errors import classify
from mirage.errors.fs import fs_error


def numbered(exc: OSError) -> OSError:
    """`exc` as a real syscall raises it: errno, strerror and path set.

    Every mirage constructor stamps the errno already, but a third-party
    mount may raise ``FileNotFoundError(path)`` with none, and pathlib
    reads the errno to tell a missing path from a broken one:
    ``Path.exists``, ``is_file`` and ``is_dir`` re-raise any OSError
    whose errno they do not recognize, so a plain ``if p.exists()`` would
    crash on a missing mounted path. An error the vocabulary cannot name
    is returned as it came.

    Args:
        exc (OSError): what the door raised, errno set or not.
    """
    condition = classify(exc)
    if exc.errno is not None or condition is None:
        return exc
    path = exc.filename if exc.filename is not None else exc.args[0]
    return fs_error(path, condition)
