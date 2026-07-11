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

from unittest.mock import Mock

import pytest


@pytest.mark.asyncio
async def test_cat_single_file(databricks_text_workspace):
    io = await databricks_text_workspace.execute("cat /dbx/words.txt")

    assert io.exit_code == 0
    assert io.stdout == b"beta\nalpha\nalpha\n"


@pytest.mark.asyncio
async def test_cat_single_file_does_not_fetch_metadata(
    databricks_text_workspace,
    databricks_text_files,
    monkeypatch,
):
    get_metadata = Mock(wraps=databricks_text_files.get_metadata)
    get_directory_metadata = Mock(
        wraps=databricks_text_files.get_directory_metadata)
    download = Mock(wraps=databricks_text_files.download)
    monkeypatch.setattr(databricks_text_files, "get_metadata", get_metadata)
    monkeypatch.setattr(databricks_text_files, "get_directory_metadata",
                        get_directory_metadata)
    monkeypatch.setattr(databricks_text_files, "download", download)

    io = await databricks_text_workspace.execute("cat /dbx/words.txt")

    assert io.exit_code == 0
    assert io.stdout == b"beta\nalpha\nalpha\n"
    get_metadata.assert_not_called()
    get_directory_metadata.assert_not_called()
    download.assert_called_once()


@pytest.mark.asyncio
async def test_cat_directory_reports_is_directory(
    databricks_text_workspace,
    databricks_text_files,
):
    root = "/Volumes/main/default/agent_files/root"
    databricks_text_files.create_directory(f"{root}/sub")

    io = await databricks_text_workspace.execute("cat /dbx/sub")

    assert io.exit_code == 1
    assert io.stderr == b"cat: /dbx/sub: Is a directory\n"


@pytest.mark.asyncio
async def test_cat_multiple_files_concatenated(databricks_text_workspace):
    io = await databricks_text_workspace.execute(
        "cat /dbx/words.txt /dbx/more.txt")

    assert io.exit_code == 0
    assert io.stdout == b"beta\nalpha\nalpha\ndelta\n"


@pytest.mark.asyncio
async def test_cat_n_numbers_lines(databricks_text_workspace):
    io = await databricks_text_workspace.execute("cat -n /dbx/words.txt")

    assert io.exit_code == 0
    assert io.stdout == b"     1\tbeta\n     2\talpha\n     3\talpha\n"
