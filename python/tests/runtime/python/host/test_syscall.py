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

import pytest

from mirage.errors.fs import erofs
from mirage.runtime.python.host.syscall import as_raised, syscall


def test_a_mirage_refusal_raises_as_the_builtin_class_for_its_errno():
    raised = as_raised(erofs("/data/f"))
    assert type(raised) is OSError
    assert (raised.errno, raised.filename) == (errno.EROFS, "/data/f")


def test_a_builtin_error_is_raised_as_it_came():
    original = FileNotFoundError(errno.ENOENT, "gone", "/f")
    assert as_raised(original) is original


def _refuse() -> None:
    raise erofs("/data/f")


def test_syscall_wraps_an_entry_point():
    with pytest.raises(OSError) as caught:
        syscall(_refuse)()
    assert type(caught.value) is OSError
    assert caught.value.errno == errno.EROFS
