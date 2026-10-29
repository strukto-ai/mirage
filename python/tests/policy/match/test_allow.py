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

from mirage.policy.match.allow import (
    head_allowed,
    line_tokens,
)
from mirage.policy.types import AdmissionRules, CommandContext, CommandRule


def _ctx(
    command: str,
    argv: tuple[str, ...] = (),
    tokens: tuple[str, ...] = (),
    tool: bool = True,
) -> CommandContext:
    return CommandContext(
        command=command,
        paths=(),
        argv=argv,
        cwd="/",
        tokens=tokens,
        tool=tool,
    )


def test_head_allowed_answers_the_roles_one_allow_list():
    rules = AdmissionRules(allow=("ls", "git log"))
    # A name is allowed when it starts a pattern of the list.
    assert head_allowed("ls", rules)
    assert head_allowed("git", rules)
    assert not head_allowed("cat", rules)
    assert not head_allowed("rm", rules)
    # A profile without a list allows everything, and so does no profile.
    assert head_allowed("rm", AdmissionRules(deny=(CommandRule("x"),)))
    assert head_allowed("rm", None)


def test_line_tokens_read_the_raw_argv_without_the_entry_point():
    assert line_tokens(_ctx("git", ("push",))) == ("git", "push")
