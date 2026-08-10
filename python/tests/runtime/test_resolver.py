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

from mirage.runtime.resolver import MountResolver, PrefixResolver


def test_prefixes_reflect_the_live_source():
    mounts = ["/data/"]
    resolver = PrefixResolver(lambda: mounts)
    assert resolver.prefixes() == ["/data/"]
    mounts.append("/logs/")
    assert resolver.prefixes() == ["/data/", "/logs/"]


def test_owner_of_answers_by_longest_match_in_source_spelling():
    resolver = PrefixResolver(lambda: ["/", "/data/", "/data/inner/"])
    assert resolver.owner_of("/data/inner/x") == "/data/inner/"
    assert resolver.owner_of("/data") == "/data/"
    assert resolver.owner_of("/other") == "/"


def test_owner_of_answers_none_off_every_mount():
    resolver = PrefixResolver(lambda: ["/data/"])
    assert resolver.owner_of("/database") is None
    assert PrefixResolver(lambda: []).owner_of("/data") is None


def test_prefix_resolver_satisfies_the_protocol():
    resolver: MountResolver = PrefixResolver(lambda: ["/data/"])
    assert resolver.owner_of("/data/x") == "/data/"
