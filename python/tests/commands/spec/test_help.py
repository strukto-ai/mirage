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

from mirage.commands.spec.help import render_help
from mirage.commands.spec.types import CommandSpec, OperandKind, Option


def test_renders_name_description_usage_and_flags():
    spec = CommandSpec(
        description="Send a thing.",
        options=(
            Option(long="--to",
                   value_kind=OperandKind.TEXT,
                   description="Recipient"),
            Option(long="--help",
                   value_kind=OperandKind.NONE,
                   description="Show help"),
        ),
    )
    out = render_help("gws thing send", spec)
    assert "gws thing send: Send a thing." in out
    assert "Usage: gws thing send [flags]" in out
    assert "--to <text>" in out
    assert "Recipient" in out
    assert "--help" in out


def test_falls_back_to_bare_name_without_description():
    spec = CommandSpec()
    out = render_help("foo", spec)
    assert out.splitlines()[0] == "foo"
