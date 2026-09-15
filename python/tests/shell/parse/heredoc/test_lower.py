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

from mirage.shell.parse import parse
from mirage.shell.parse.heredoc.lower import lower_heredocs
from mirage.shell.parse.heredoc.reader import discover_heredocs


def test_lowering_keeps_source_locations_for_unicode_body():
    source = "echo é; cat <<終\n世界\n終".encode()
    lowered = lower_heredocs(source, discover_heredocs(source, []))
    assert len(lowered.offsets) == len(lowered.source) + 1
    start, doc = lowered.documents[0]
    assert lowered.source[start:start + 1] == b"<"
    assert source[lowered.offsets[start]:].startswith("<<終".encode())
    assert doc.body == "世界\n".encode()


def test_other_parser_repairs_preserve_heredoc_identity():
    root = parse("cat > /api/$c/$id.json <<EOF\nbody\nEOF")
    redirect = root.named_children[0].named_children[-1]
    assert redirect.heredoc.body == b"body\n"
