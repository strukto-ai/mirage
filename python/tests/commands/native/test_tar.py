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


def test_tar_cz_tf(env):
    env.create_file("a.txt", b"aaa\n")
    env.create_file("b.txt", b"bbb\n")
    env.mirage("tar -c -z -f /data/out.tar.gz /data/a.txt /data/b.txt")
    listing = env.mirage("tar -t -f /data/out.tar.gz")
    names = listing.strip().splitlines()
    assert "a.txt" in " ".join(names)
    assert "b.txt" in " ".join(names)


def test_tar_j_create_list(env):
    env.create_file("a.txt", b"aaa\n")
    env.create_file("b.txt", b"bbb\n")
    env.mirage("tar -c -j -f /data/out.tar.bz2 /data/a.txt /data/b.txt")
    listing = env.mirage("tar -t -f /data/out.tar.bz2")
    names = listing.strip().splitlines()
    assert "a.txt" in " ".join(names)
    assert "b.txt" in " ".join(names)


def test_tar_J_create_list(env):
    env.create_file("a.txt", b"aaa\n")
    env.create_file("b.txt", b"bbb\n")
    env.mirage("tar -c -J -f /data/out.tar.xz /data/a.txt /data/b.txt")
    listing = env.mirage("tar -t -f /data/out.tar.xz")
    names = listing.strip().splitlines()
    assert "a.txt" in " ".join(names)
    assert "b.txt" in " ".join(names)


def test_tar_strip_components(env):
    env.create_file("a.txt", b"aaa\n")
    env.mirage("tar -c -z -f /data/out.tar.gz /data/a.txt")
    env.mirage(
        "tar -x -z -f /data/out.tar.gz --strip-components 1 -C /data/extracted"
    )
    content = env.mirage("cat /data/extracted/a.txt")
    assert "aaa" in content


def test_tar_exclude(env):
    env.create_file("a.txt", b"aaa\n")
    env.create_file("b.txt", b"bbb\n")
    env.mirage(
        "tar -c -z -f /data/out.tar.gz --exclude b.txt /data/a.txt /data/b.txt"
    )
    listing = env.mirage("tar -t -f /data/out.tar.gz")
    names = listing.strip().splitlines()
    assert "b.txt" not in " ".join(names)
    assert "a.txt" in " ".join(names)


def test_tar_v(env):
    env.create_file("a.txt", b"aaa\n")
    env.mirage("tar -c -v -z -f /data/out.tar.gz /data/a.txt")
    listing = env.mirage("tar -t -f /data/out.tar.gz")
    assert "a.txt" in listing


def test_tar_old_style_cluster_create_list_extract(env):
    env.create_file("a.txt", b"aaa\n")
    env.mirage("tar czf /data/out.tar.gz /data/a.txt")
    listing = env.mirage("tar tzf /data/out.tar.gz")
    assert "a.txt" in listing
    env.mirage("tar xzf /data/out.tar.gz -C /data/ex")
    assert "aaa" in env.mirage("cat /data/ex/data/a.txt")


def test_tar_old_style_value_letter_before_bool_letter_compresses(env):
    # GNU: `tar cfz a.tgz f` gzips, so -f takes the archive and z stays
    # a flag; listing it back with -z proves the stream is gzip.
    env.create_file("a.txt", b"aaa\n")
    env.mirage("tar cfz /data/out.tar.gz /data/a.txt")
    assert "a.txt" in env.mirage("tar tzf /data/out.tar.gz")


def test_tar_old_style_two_value_letters_bind_in_letter_order(env):
    env.create_file("a.txt", b"aaa\n")
    env.mirage("tar czf /data/out.tar.gz /data/a.txt")
    env.mirage("tar xzCf /data/ex /data/out.tar.gz")
    assert "aaa" in env.mirage("cat /data/ex/data/a.txt")


def test_tar_old_style_verbose_lists_members(env):
    env.create_file("a.txt", b"aaa\n")
    assert "a.txt" in env.mirage("tar cvzf /data/out.tar.gz /data/a.txt")
