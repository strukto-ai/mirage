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

from mirage.policy.match import (
    closed,
    closed_by_default,
    has_rules,
    reads_args,
    scopes_paths,
)
from mirage.policy.types import AdmissionRules
from tests.fixtures.command_trees import trees


def test_has_rules_is_a_profile_stating_a_tree():
    assert not has_rules(None)
    assert not has_rules(AdmissionRules())
    assert has_rules(trees({"rm": "deny"}))


def test_reads_args_only_where_a_node_reads_past_the_name():
    rules = trees(
        {
            "*": "allow",
            "rm": "deny",
            "git": {"push": {"--force": "deny"}},
        },
        mounts={"/repo": {"ls": "deny"}},
    )
    assert reads_args(rules, "git")
    assert reads_args(rules, "ls")
    assert not reads_args(rules, "rm")
    assert not reads_args(rules, "echo")
    assert not reads_args(None, "rm")


def test_scopes_paths_is_a_folder_tree_that_speaks_for_the_command():
    rules = trees({"rm": "deny"}, mounts={"/repo": {"ls": "deny"}})
    assert scopes_paths(rules, "ls")
    assert not scopes_paths(rules, "rm")
    assert not scopes_paths(rules, "echo")
    assert not scopes_paths(None, "cat")


def test_closed_is_a_top_level_root_that_denies_and_names_nothing():
    assert closed(trees({"*": "deny"}))
    assert closed_by_default(trees({"*": "deny"}))
    listed = trees({"*": "deny", "ls": "allow"})
    assert not closed(listed)
    assert closed_by_default(listed)
    assert not closed_by_default(trees(mounts={"/a": {"*": "deny"}}))
    assert not closed(None)
