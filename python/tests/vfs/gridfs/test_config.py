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

import pytest
from pydantic import ValidationError

from mirage.vfs.gridfs.config import GridFSConfig


def _config(**fields):
    return GridFSConfig(uri="mongodb://h", database="db", **fields)


def test_keep_revisions_is_unset_by_default():
    assert _config().keep_revisions is None


def test_keep_revisions_keeps_at_least_one():
    assert _config(keep_revisions=1).keep_revisions == 1
    with pytest.raises(ValidationError):
        _config(keep_revisions=0)


def test_unknown_field_is_refused():
    with pytest.raises(ValidationError):
        _config(keep=3)
