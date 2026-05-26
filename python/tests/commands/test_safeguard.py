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

from mirage.commands.safeguard import (DEFAULT_COMMAND_SAFEGUARDS,
                                       CommandSafeguard, resolve_safeguard)
from mirage.types import OnExceed


def test_defaults():
    sg = CommandSafeguard()
    assert sg.max_bytes is None
    assert sg.max_lines is None
    assert sg.on_exceed == OnExceed.TRUNCATE


def test_on_exceed_coerces_from_string():
    sg = CommandSafeguard(on_exceed="truncate")
    assert sg.on_exceed is OnExceed.TRUNCATE


def test_rejects_unknown_on_exceed():
    with pytest.raises(ValidationError):
        CommandSafeguard(on_exceed="explode")


def test_rejects_negative_limits():
    with pytest.raises(ValidationError):
        CommandSafeguard(max_bytes=-1)
    with pytest.raises(ValidationError):
        CommandSafeguard(max_lines=-5)


def test_resolve_prefers_mount_override():
    override = CommandSafeguard(max_lines=5)
    default = CommandSafeguard(max_lines=50)
    assert resolve_safeguard("cat", default, override) is override


def test_resolve_falls_back_to_command_default():
    default = CommandSafeguard(max_lines=50)
    assert resolve_safeguard("cat", default, None) is default


def test_resolve_falls_back_to_central_default():
    assert resolve_safeguard("cat", None,
                             None) is DEFAULT_COMMAND_SAFEGUARDS["cat"]


def test_resolve_unknown_command_has_no_safeguard():
    assert resolve_safeguard("nl", None, None) is None
