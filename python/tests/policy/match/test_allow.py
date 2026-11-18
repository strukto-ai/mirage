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

from mirage.policy.match.allow import line_tokens, runs
from mirage.policy.types import CommandContext
from tests.fixtures.command_trees import trees


def test_runs_unless_a_tree_that_holds_everywhere_denies_every_line():
    assert runs("rm", None)
    rules = trees({"*": "deny", "ls": "allow", "git": {"push": "deny"}})
    assert runs("ls", rules)
    assert not runs("git", rules)
    assert not runs("rm", rules)
    assert runs("git", trees({"git": {"push": "deny"}}))
    assert not runs("cat", trees({"cat": "deny"}))
    assert runs("cat", trees(mounts={"/a": {"cat": "deny"}}))


def test_line_tokens_read_the_raw_argv_without_the_entry_point():
    ctx = CommandContext(command="git", paths=(), argv=("push",), cwd="/")
    assert line_tokens(ctx) == ("git", "push")
