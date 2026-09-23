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

from mirage.commands.builtin.generic.archive import zipinfo

STAMP = (2026, 9, 20, 7, 33, 0)


def _row(**over) -> zipinfo.ZipRow:
    base = dict(name="document.txt",
                size=5,
                csize=5,
                method=0,
                flags=0,
                internal_attr=0,
                external_attr=0o600 << 16,
                host=3,
                host_version=20,
                date_time=STAMP,
                has_extra=False)
    base.update(over)
    return zipinfo.ZipRow(**base)


def test_short_row_matches_info_zip():
    assert zipinfo.render_row(_row(), "short") == (
        "?rw-------  2.0 unx        5 b- stor 26-Sep-20 07:33 document.txt")


def test_long_row_adds_the_compressed_size():
    row = _row(name="dir/a.txt",
               size=200,
               csize=6,
               method=8,
               external_attr=0o100664 << 16)
    assert zipinfo.render_row(row, "long") == (
        "-rw-rw-r--  2.0 unx      200 b-        6 defN 26-Sep-20 07:33 "
        "dir/a.txt")


def test_directory_row_and_deflate_level_letter():
    row = _row(name="dir/",
               size=0,
               csize=2,
               method=8,
               flags=2,
               external_attr=(0o40775 << 16) | 0x10)
    assert zipinfo.render_row(row, "short") == (
        "drwxrwxr-x  2.0 unx        0 b- defX 26-Sep-20 07:33 dir/")


def test_zero_stamp_renders_a_bogus_month():
    row = _row(date_time=(1980, 0, 0, 0, 0, 0))
    assert zipinfo.render_row(
        row, "short").endswith(" 80-000-00 00:00 document.txt")


def test_fat_host_renders_dos_attributes():
    row = _row(name="setup.exe", host=0, external_attr=0x21)
    assert zipinfo.render_row(row, "short") == (
        "-r-xa--     2.0 fat        5 b- stor 26-Sep-20 07:33 setup.exe")


def test_fat_host_whose_unix_bits_shadow_the_dos_byte_renders_unix():
    row = _row(host=0, external_attr=(0o600 << 16) | 0x20)
    assert zipinfo.render_row(row, "short").startswith("?rw-------  2.0 fat ")


def test_text_extra_encrypted_and_descriptor_letters():
    assert " tx stor " in zipinfo.render_row(
        _row(internal_attr=1, has_extra=True), "short")
    assert " Bl stor " in zipinfo.render_row(_row(flags=1 | 8), "short")


def test_medium_row_adds_percent_saved_truncated_toward_zero():
    assert zipinfo.render_row(
        _row(name="dir/", size=0, csize=2, method=8),
        "medium") == ("?rw-------  2.0 unx        0 b-  0% defN "
                      "26-Sep-20 07:33 dir/")
    assert zipinfo.render_row(
        _row(name="dir/a.txt", size=200, csize=6, method=8),
        "medium") == ("?rw-------  2.0 unx      200 b- 97% defN "
                      "26-Sep-20 07:33 dir/a.txt")
    assert zipinfo.render_row(
        _row(name="b.txt", size=1, csize=3, method=8),
        "medium") == ("?rw-------  2.0 unx        1 b--199% defN "
                      "26-Sep-20 07:33 b.txt")


def test_unknown_method_and_host_past_the_table():
    row = _row(method=99, host=40)
    assert " ??? " in zipinfo.render_row(row, "short")
    assert " u099 " in zipinfo.render_row(row, "short")


def test_ratio_is_info_zip_tenths_rounded_and_signed():
    assert zipinfo.compression_ratio(201, 11) == 945
    assert zipinfo.compression_ratio(5, 9) == -800
    assert zipinfo.compression_ratio(4, 6) == -500
    assert zipinfo.compression_ratio(0, 0) == 0


def test_totals_line():
    assert zipinfo.render_totals([
        _row()
    ]) == ("1 file, 5 bytes uncompressed, 5 bytes compressed:  0.0%\n")
    rows = [_row(size=4, csize=6), _row(name="d/", size=0, csize=0)]
    assert zipinfo.render_totals(rows) == (
        "2 files, 4 bytes uncompressed, 6 bytes compressed:  -50.0%\n")


def test_encrypted_entry_header_is_not_compressed_data():
    assert zipinfo.render_totals([
        _row(flags=1, csize=17)
    ]) == ("1 file, 5 bytes uncompressed, 5 bytes compressed:  0.0%\n")


def test_header_lines():
    assert zipinfo.render_header(
        "/data/x.zip", 127,
        1) == ("Archive:  /data/x.zip\n"
               "Zip file size: 127 bytes, number of entries: 1\n")


def _layout(**over) -> zipinfo.ZipinfoLayout:
    base = dict(names_only=False,
                names_headers=False,
                long=False,
                medium=False,
                short=False,
                header=False,
                totals=False,
                has_members=False)
    base.update(over)
    return zipinfo.zipinfo_layout(**base)


def test_layout_follows_zi_opts():
    assert _layout() == zipinfo.ZipinfoLayout("short", True, True)
    assert _layout(long=True) == zipinfo.ZipinfoLayout("long", True, True)
    assert _layout(medium=True) == zipinfo.ZipinfoLayout("medium", True, True)
    assert _layout(short=True,
                   header=True) == zipinfo.ZipinfoLayout("short", True, True)
    assert _layout(medium=True, has_members=True) == zipinfo.ZipinfoLayout(
        "medium", False, False)
    assert _layout(names_only=True, header=True,
                   totals=True) == zipinfo.ZipinfoLayout(
                       "names", False, False)
    assert _layout(names_headers=True,
                   header=True) == zipinfo.ZipinfoLayout("names", True, False)
    assert _layout(header=True) == zipinfo.ZipinfoLayout("none", True, False)
    assert _layout(totals=True) == zipinfo.ZipinfoLayout("none", False, True)
    assert _layout(has_members=True) == zipinfo.ZipinfoLayout(
        "short", False, False)
    assert _layout(header=True, has_members=True) == zipinfo.ZipinfoLayout(
        "short", True, False)
    assert _layout(names_only=True,
                   names_headers=True) == zipinfo.ZipinfoLayout(
                       "names", False, False)
