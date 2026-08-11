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

from mirage.runtime.python.flags import init_argv, unhonored, unhonored_notice


def test_an_empty_bag_asks_for_nothing():
    assert init_argv({}) == []


def test_a_bool_switch_goes_back_in_cpythons_own_spelling():
    assert init_argv({"B": True, "E": False, "P": True}) == ["-B", "-P"]


def test_a_count_switch_repeats_because_cpython_counts_occurrences():
    # CPython reads `-O -O` exactly as `-OO`; the same is true of -b.
    assert init_argv({"O": 2, "b": 1}) == ["-O", "-O", "-b"]


def test_a_list_switch_repeats_the_spelling_per_value():
    assert init_argv({"W": ["ignore", "error::UserWarning"]
                      }) == ["-W", "ignore", "-W", "error::UserWarning"]


def test_the_long_switch_goes_back_as_two_words():
    # CPython parses --check-hash-based-pycs by hand and rejects the
    # --opt=value spelling, so it can only be handed back detached.
    assert init_argv({"check_hash_based_pycs":
                      "never"}) == ["--check-hash-based-pycs", "never"]


def test_an_engine_that_honors_nothing_reports_every_switch_present():
    flags = {
        "B": True,
        "O": 2,
        "W": ["ignore"],
        "check_hash_based_pycs": "never"
    }
    assert unhonored(flags) == ["-B", "-O", "-W", "--check-hash-based-pycs"]


def test_a_switch_the_engine_honors_is_not_reported():
    flags = {"B": True, "O": 2, "E": True}
    assert unhonored(flags, ("B", "O")) == ["-E"]


def test_an_absent_switch_is_not_reported():
    assert unhonored({"B": False, "O": 0, "W": []}) == []


def test_the_notice_names_the_runtime_once_per_switch():
    notice = unhonored_notice({"E": True, "s": True}, "pyodide")
    assert notice == (b"python3: warning: -E is ignored by the 'pyodide' "
                      b"runtime\n"
                      b"python3: warning: -s is ignored by the 'pyodide' "
                      b"runtime\n")


def test_the_notice_is_empty_when_the_line_carried_no_switch():
    assert unhonored_notice({}, "pyodide") == b""


def test_a_known_x_name_is_reported_by_name():
    # Populating sys._xoptions is all a warm interpreter can do for
    # -X dev, whose real effect is read out of the read-only sys.flags.
    assert unhonored({"X": ["dev"]}, ("X", )) == ["-X dev"]


def test_a_known_x_name_with_a_value_is_reported_without_it():
    assert unhonored({"X": ["tracemalloc=5"]}, ("X", )) == ["-X tracemalloc"]


def test_an_arbitrary_x_name_stays_silent():
    # On CPython it does nothing but land in sys._xoptions either.
    assert unhonored({"X": ["nosuchopt"]}, ("X", )) == []


def test_an_engine_that_acts_on_a_known_x_name_says_nothing():
    assert unhonored({"X": ["dev"]}, ("X", "X:dev")) == []
