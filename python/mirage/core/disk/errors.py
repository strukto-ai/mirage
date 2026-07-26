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

from collections.abc import Iterator
from contextlib import contextmanager


def disk_error(exc: OSError, virtual: str) -> OSError:
    """Restamp one OSError against the mount path (mirrors TS ``diskError``).

    Used directly by call sites that only know which operand to blame after
    seeing the failure, such as a two-operand copy where ENOENT can mean
    either a missing source or a missing destination parent.

    Args:
        exc (OSError): The raw error from the real filesystem.
        virtual (str): The operand's virtual path, stamped as ``filename``.
    """
    return type(exc)(exc.errno, exc.strerror, virtual)


@contextmanager
def disk_errors(virtual: str) -> Iterator[None]:
    """Re-raise an OSError from the real filesystem against the mount path.

    The disk backend operates on a resolved host path, so a raw OSError
    carries that host path in ``filename`` and ``format_fs_error`` would
    print it. Only the virtual path may ever reach a user-facing message:
    the host root is an implementation detail of the mount, and leaking it
    discloses the server's directory layout. The errno and strerror are
    preserved, so the GNU wording at the command boundary is unchanged.

    Args:
        virtual (str): The operand's virtual path, stamped as ``filename``.
    """
    try:
        yield
    except OSError as exc:
        raise disk_error(exc, virtual) from exc
