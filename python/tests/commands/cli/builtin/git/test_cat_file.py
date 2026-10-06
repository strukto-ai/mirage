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


@pytest.mark.asyncio
async def test_type_and_object_peel_a_tag_to_what_it_tags(git_rw):
    result = await git_rw.shell(
        "cd /repo && git tag -a v1 -m release && git cat-file -t v1 && "
        "git cat-file commit v1 | git hash-object -t commit --stdin && "
        "git cat-file tree v1 | git hash-object -t tree --stdin && "
        "git rev-parse HEAD 'HEAD^{tree}'"
    )
    kind, commit, tree, *ids = result.stdout.decode().split()
    assert (kind, [commit, tree]) == ("tag", ids)
