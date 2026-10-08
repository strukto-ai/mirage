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

from mirage.policy.constants import METADATA_OPS, SUBTREE_OPS
from mirage.vfs.base import BaseVFS
from mirage.vfs.call import call_names, declared_calls
from mirage.vfs.types import Effect, Target

_CALLS = declared_calls(BaseVFS)


def test_subtree_ops_are_what_the_functions_declare():
    # A rename and a directory removal take everything under them along;
    # rm_r is the command tier's, which no VFS function declares.
    declared = call_names(_CALLS, effects={Effect.RENAME}) | call_names(
        _CALLS, effects={Effect.REMOVE}, targets={Target.DIR}
    )
    assert SUBTREE_OPS == declared | {"rm_r"}


def test_metadata_ops_are_what_the_functions_declare():
    declared = call_names(_CALLS, effects={Effect.METADATA})
    assert METADATA_OPS == declared | {"exists"}
