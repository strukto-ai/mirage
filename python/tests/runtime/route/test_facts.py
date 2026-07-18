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

from mirage.runtime.route import command_facts
from mirage.workspace.workspace import parse


def test_command_facts_parse_pipes_and_lists():
    facts = command_facts(parse("cat /a/big.csv | python3 /r/x.py 1 && nope"))
    assert [f.command for f in facts] == ["cat", "python3", "nope"]
    assert facts[0].paths == ("/a/big.csv", )
    assert facts[1].words == ("python3", "/r/x.py", "1")
    assert facts[0].builtin and facts[1].builtin
    assert not facts[2].builtin


def test_command_facts_empty_on_unparsable():
    assert command_facts(parse("")) == ()
