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

from mirage.commands.cli.builtin.tvly.urls import (
    host_of,
    hostname_of,
    page_slug,
    parse_url,
)


def test_a_url_splits_into_the_parts_tvly_reads():
    parsed = parse_url("HTTPS://Docs.Example.com:8443/a b?q=1#top")
    assert parsed is not None
    assert parsed.hostname == "docs.example.com"
    assert parsed.host == "docs.example.com:8443"
    assert parsed.pathname == "/a%20b"
    assert parsed.search == "?q=1"


def test_the_default_port_is_dropped_from_the_host():
    assert host_of("https://example.com:443/x") == "example.com"
    assert host_of("http://example.com:80") == "example.com"


def test_text_that_is_no_url_keeps_its_fallbacks():
    assert parse_url("not a url") is None
    assert hostname_of("not a url") == ""
    assert host_of("not a url") == "not a url"


@pytest.mark.parametrize(
    ("url", "slug"),
    [
        (
            "https://docs.example.com/guide/intro/",
            "docs.example.com_guide_intro",
        ),
        ("https://example.com/", "example.com"),
        ("https://example.com/a?x=1", "example.com_a_x_1"),
        ("///", "index"),
    ],
)
def test_a_page_slug_is_its_location_with_unsafe_characters_folded(url, slug):
    assert page_slug(url) == slug
