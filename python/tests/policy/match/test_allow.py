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
    head_visible,
    line_allowed,
    line_tokens,
    node_visible,
)
from mirage.policy.types import AdmissionRules, CommandContext, CommandRule


class _Registry:
    def is_mount_root(self, path: str) -> bool:
        return False


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
        registry=_Registry(),
        tokens=tokens,
        tool=tool,
    )


def test_head_visible_answers_the_roles_one_allow_list():
    rules = AdmissionRules(allow=("ls", "git log"))
    # A name is visible when it starts a pattern of the list.
    assert head_visible("ls", rules)
    assert head_visible("git", rules)
    assert not head_visible("cat", rules)
    assert not head_visible("rm", rules)
    # A profile without a list hides nothing, and neither does no profile.
    assert head_visible("rm", AdmissionRules(deny=(CommandRule("x"),)))
    assert head_visible("rm", None)


def test_node_visible_narrows_a_tree_one_verb_at_a_time():
    rules = AdmissionRules(allow=("ls", "linear issue list"))
    # The head is visible because some line of it is allowed, and so is
    # every node on the way down to that line.
    assert node_visible(("linear",), rules)
    assert node_visible(("linear", "issue"), rules)
    assert node_visible(("linear", "issue", "list"), rules)
    # A sibling of that path is not, at either depth.
    assert not node_visible(("linear", "team"), rules)
    assert not node_visible(("linear", "issue", "create"), rules)
    # head_visible is the one-word case, and agrees.
    assert head_visible("linear", rules) == node_visible(("linear",), rules)
    # A profile without a list hides no node of any tree.
    assert node_visible(("linear", "team"), None)
    assert node_visible(
        ("linear", "team"), AdmissionRules(deny=(CommandRule("x"),))
    )


def test_line_allowed_reads_the_whole_line_and_skips_non_tools():
    rules = AdmissionRules(allow=("ls", "git log", "git status"))
    assert line_allowed(_ctx("ls", ("-la",), tokens=("ls", "-la")), rules)
    assert line_allowed(_ctx("git", tokens=("git", "log", "-1")), rules)
    # The head is visible (some git line is allowed) but this line is
    # covered by no pattern.
    assert not line_allowed(_ctx("git", tokens=("git", "push")), rules)
    # A word that is not a tool is never refused by an allow list.
    assert line_allowed(_ctx("cd", tokens=("cd", "/x"), tool=False), rules)
    # A context built without the entry point's tokens reads the raw argv.
    raw = _ctx("git", ("push",))
    assert line_tokens(raw) == ("git", "push")
    assert not line_allowed(raw, rules)
