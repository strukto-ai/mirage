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

from mirage.utils.encoding import bom_of


def test_bom_of_names_the_mark_a_stream_starts_with():
    assert bom_of(b"\xef\xbb\xbfx") == (b"\xef\xbb\xbf", "UTF-8")
    assert bom_of(b"\xff\xfeh") == (b"\xff\xfe", "UTF-16LE")
    assert bom_of(b"\xfe\xff") == (b"\xfe\xff", "UTF-16BE")
    assert bom_of(b"\xef\xbb") is None
