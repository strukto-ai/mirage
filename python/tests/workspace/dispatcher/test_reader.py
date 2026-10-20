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

from mirage.types import Visibility
from mirage.utils.hidden import classify_paths
from tests.fixtures.readers import readers


def test_hides_under_names_a_subtree_holding_a_hidden_entry():
    vis = Visibility(paths=classify_paths(["/repo/secret.txt"]))
    reader = readers(visibility=vis)("agent")
    assert reader.hides_under("/repo")
    assert reader.hides_under("/repo/secret.txt")
    assert not reader.hides_under("/other")
    assert not reader.visible("/repo/secret.txt")
    assert reader.visible("/repo/ok.txt")


def test_hides_under_is_false_without_hides():
    assert not readers()("agent").hides_under("/repo")


class Links:
    """A link table holding one link."""

    def __init__(self, link: str, target: str) -> None:
        self.table = {link: target}

    def symlink_targets(self) -> dict[str, str]:
        return self.table


def test_hides_under_counts_a_link_that_can_lead_into_a_hide():
    vis = Visibility(paths=classify_paths(["/outside/private"]))
    links = Links("/repo/link", "/outside/private")
    reader = readers(links=links, visibility=vis)("agent")  # type: ignore[arg-type]
    assert reader.hides_under("/repo")
    assert reader.hides_under("/repo/link/secret.txt")
    assert not reader.hides_under("/elsewhere")
