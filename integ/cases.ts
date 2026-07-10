// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import type { ProvisionResult, Workspace } from "@struktoai/mirage-node";

export const SEED_FILES: Record<string, string> = {
  "/data/a.txt": "hello\nworld\nfoo\nbar\nbaz\n",
  "/data/b.txt": "1\n2\n3\n",
  "/data/user.json": '{"name": "alice", "age": 30}\n',
  "/data/users.json":
    '{"users": [{"name": "alice", "age": 30}, {"name": "bob", "age": 25}]}\n',
  "/data/data.jsonl": '{"id":1}\n{"id":2}\n{"id":3}\n',
  "/data/chat.jsonl": '{"msg":"hello"}\n{"msg":"world"}\n',
  "/data/dup.txt": "a\na\nb\nb\nc\n",
  "/data/csv.csv": "name,age\nalice,30\nbob,25\n",
  "/data/tabbed.txt": "a\t1\nb\t2\nc\t3\n",
  "/data/mixed.txt": "Hello World\nHELLO world\nhello WORLD\n",
  "/data/numbers.txt": "10\n2\n30\n4\n5\n",
  "/data/sorted_a.txt": "apple\nbanana\ncherry\n",
  "/data/sorted_b.txt": "banana\ndate\nelder\n",
  "/data/binary.bin": "\x00\x01\x02hello\xff\xfe",
  "/data/empty.txt": "",
  "/data/no_nl.txt": "no trailing newline",
  "/data/one_byte.txt": "x",
  "/data/sub/nested.txt": "nested\ncontent\n",
  "/data/sub/deep/deeper.txt": "deep\n",
  "/data/fields.txt": "alice 30 engineer\nbob 25 designer\ncarol 40 manager\n",
  "/data/spaced.txt": "  leading\ntrailing  \n  both  \n",
  "/data/sections.txt": "section1\nbody1\nsection2\nbody2\nsection3\nbody3\n",
  "/data/repeats.txt": "x\nx\nx\ny\ny\nz\n",
  "/data/c.txt": "alpha\nbeta\ngamma\ndelta\n",
  "/data/abc.csv": "a,1\nb,2\nc,3\nd,4\ne,5\n",
  "/data/sorted_c.txt": "apple\ncherry\nelder\nfig\n",
  "/data/prefix_dup.txt": "1 apple\n2 apple\n3 banana\n",
  "/data/patterns.txt": "world\nbar\n",
  "/data/patterns2.txt": "baz\n",
  "/data/guard/g.txt": "guard\n",
  "/data/guard/sub/s.txt": "inner\n",
  "/data/anchors.txt": "#123\nls\n#456\nfoo bar\n",
  "/data/multi.txt": "oo\noo\noo\n",
  "/data/oooo.txt": "oooo\noooo\n",
  // dedicated clean subtree for traversal-display cases (no other case
  // writes under it, so listings/walks are deterministic)
  "/data/disptree/x.txt": "nested\ncontent\n",
  "/data/disptree/d/y.txt": "deep\n",
  // patch round-trip: a unified diff whose hunk has a leading context line,
  // so an applier that anchors on the hunk start instead of walking context
  // corrupts the first line. The diff and target are seeded; the cases below
  // apply, re-apply with -N, and reverse it.
  "/data/poem.txt": "roses are red\nviolets are blue\nsugar is sweet\n",
  "/data/poem.diff":
    "--- a/poem.txt\n+++ b/poem.txt\n@@ -1,3 +1,3 @@\n" +
    " roses are red\n-violets are blue\n+violets are dark\n sugar is sweet\n",
};

export const CASES: ReadonlyArray<readonly [string, string]> = [
  ["cat_simple", "cat /data/a.txt"],
  ["cat_concat", "cat /data/a.txt /data/b.txt"],
  ["cat_n", "cat -n /data/a.txt"],
  ["head_default", "head /data/a.txt"],
  ["head_n1", "head -n 1 /data/a.txt"],
  ["head_n2", "head -n 2 /data/a.txt"],
  ["head_c5", "head -c 5 /data/a.txt"],
  ["tail_default", "tail /data/a.txt"],
  ["tail_n1", "tail -n 1 /data/a.txt"],
  ["tail_n2", "tail -n 2 /data/a.txt"],

  ["wc", "wc /data/a.txt"],
  ["wc_l", "wc -l /data/a.txt"],
  ["wc_w", "wc -w /data/a.txt"],
  ["wc_c", "wc -c /data/a.txt"],

  ["grep_world", "grep world /data/a.txt"],
  ["grep_n", "grep -n bar /data/a.txt"],
  ["grep_v", "grep -v foo /data/a.txt"],
  ["grep_i", "grep -i HELLO /data/mixed.txt"],
  ["grep_c", "grep -c hello /data/mixed.txt"],
  ["grep_E_alt", 'grep -E "foo|bar" /data/a.txt'],
  ["rg_basic", "rg world /data/a.txt"],
  ["rg_i", "rg -i WORLD /data/mixed.txt"],

  ["jq_dot", 'jq "." /data/user.json'],
  ["jq_name", 'jq ".name" /data/user.json'],
  ["jq_age", 'jq ".age" /data/user.json'],
  ["jq_raw", 'jq -r ".name" /data/user.json'],
  ["jq_array_iter", 'jq ".users[].name" /data/users.json'],
  ["jq_jsonl_id", 'jq ".id" /data/data.jsonl'],
  ["jq_jsonl_chain", 'jq ".[].id" /data/data.jsonl'],
  ["jq_jsonl_chain_raw", 'jq -r ".[].msg" /data/chat.jsonl'],
  ["jq_no_filter_piped", "cat /data/user.json | jq"],

  ["sort", "sort /data/a.txt"],
  ["sort_r", "sort -r /data/a.txt"],
  ["sort_n", "sort -n /data/numbers.txt"],
  ["uniq", "uniq /data/dup.txt"],
  ["uniq_c", "uniq -c /data/dup.txt"],
  ["uniq_d", "uniq -d /data/dup.txt"],

  ["nl", "nl /data/a.txt"],
  ["rev", "rev /data/a.txt"],
  ["tac", "tac /data/a.txt"],

  ["cut_f1", "cut -f 1 -d , /data/csv.csv"],
  ["cut_f2", "cut -f 2 -d , /data/csv.csv"],
  ["cut_c2_4", "cut -c 2-4 /data/a.txt"],
  ["cut_tab", "cut -f 1 /data/tabbed.txt"],
  ["paste", "paste /data/a.txt /data/b.txt"],
  ["comm", "comm /data/sorted_a.txt /data/sorted_b.txt"],

  ["tr_upper", "cat /data/a.txt | tr a-z A-Z"],
  ["tr_delete", "cat /data/a.txt | tr -d aeiou"],
  ["sed_sub", "cat /data/a.txt | sed s/world/UNIVERSE/"],
  ["sed_global", "cat /data/mixed.txt | sed s/hello/HI/g"],
  ["awk_first_col", "cat /data/csv.csv | awk -F, '{print $1}'"],
  ["awk_nr", "awk 'NR==2' /data/a.txt"],
  ["awk_sum", "awk '{s+=$1} END{print s}' /data/numbers.txt"],

  ["md5", "md5 /data/a.txt"],
  ["md5_multi", "md5 /data/a.txt /data/b.txt"],
  ["sha256sum", "sha256sum /data/a.txt"],
  ["base64", "base64 /data/a.txt"],
  ["xxd", "head -c 8 /data/a.txt | xxd"],
  ["xxd_p", "head -c 8 /data/a.txt | xxd -p"],

  ["basename", "basename /data/a.txt"],
  ["basename_suffix", "basename /data/a.txt .txt"],
  ["basename_trailing_slash", "basename /data/sub/"],
  ["basename_root", "basename /"],
  ["basename_relative", "basename data/a.txt"],
  ["dirname", "dirname /data/a.txt"],
  ["dirname_trailing_slash", "dirname /data/sub/"],
  ["dirname_multi", "dirname /data/a.txt /data/sub/nested.txt"],
  ["dirname_relative", "dirname a.txt"],
  ["dirname_root", "dirname /"],
  ["realpath", "realpath /data/a.txt"],

  ["find_name", 'find /data -name "*.txt"'],
  ["find_type_f", "find /data -type f"],
  ["ls", "ls /data/"],
  ["ls_1", "ls -1 /data/"],
  ["ls_file", "ls /data/a.txt"],
  ["ls_glob", "ls /data/*.txt"],

  ["expand", "cat /data/tabbed.txt | expand"],
  ["fold", "cat /data/a.txt | fold -w 3"],
  ["strings", "strings /data/binary.bin"],

  ["nl_ba", "nl -b a /data/a.txt"],
  ["fmt_w20", "cat /data/a.txt | fmt -w 20"],
  ["unexpand", "cat /data/tabbed.txt | unexpand"],
  ["column_t", "column -s , -t /data/csv.csv"],
  ["look", "look hel /data/a.txt"],
  ["join", "join /data/sorted_a.txt /data/sorted_b.txt"],

  ["grep_A1", "grep -A 1 world /data/a.txt"],
  ["grep_B1", "grep -B 1 foo /data/a.txt"],
  ["grep_o", "grep -o ll /data/a.txt"],
  ["grep_l", "grep -l hello /data/mixed.txt /data/a.txt"],

  ["file_text", "file /data/a.txt"],
  ["file_json", "file /data/user.json"],
  ["file_b", "file -b /data/a.txt"],
  ["stat_size", 'stat -c "%s" /data/a.txt'],
  ["stat_name", 'stat -c "%n" /data/a.txt'],

  ["gzip_gunzip_pipe", "cat /data/a.txt | gzip | gunzip"],
  ["gzip_zcat_pipe", "cat /data/a.txt | gzip | zcat"],
  ["base64_roundtrip", "cat /data/a.txt | base64 | base64 -d"],
  ["xxd_roundtrip", "cat /data/a.txt | xxd | xxd -r"],

  ["find_mindepth", "find /data -mindepth 1 -type f"],
  ["find_maxdepth", "find /data -maxdepth 1 -type f"],
  ["find_multi_name", 'find /data -name "*.txt" -o -name "*.json"'],

  ["wc_multi", "wc /data/a.txt /data/b.txt"],
  ["wc_l_multi", "wc -l /data/a.txt /data/b.txt"],
  ["cat_multi3", "cat /data/a.txt /data/b.txt /data/dup.txt"],
  ["md5_multi3", "md5 /data/a.txt /data/b.txt /data/dup.txt"],
  ["du_multi", "du /data/a.txt /data/b.txt"],
  ["file_multi", "file /data/a.txt /data/user.json"],

  ["grep_pipe_wc", "grep world /data/a.txt | wc -l"],
  ["sort_uniq", "sort /data/dup.txt | uniq"],
  ["cat_pipe_head", "cat /data/a.txt | head -n 2"],
  ["cat_pipe_sort_pipe_uniq", "cat /data/dup.txt | sort | uniq -c"],
  ["find_pipe_wc", 'find /data -name "*.txt" | wc -l'],
  ["jq_pipe_wc", 'jq ".id" /data/data.jsonl | wc -l'],
  ["cat_tr_sort", "cat /data/a.txt | tr a-z A-Z | sort"],
  ["cat_tr_wc", "cat /data/a.txt | tr -d aeiou | wc -c"],
  ["head_pipe_tail", "head -n 3 /data/a.txt | tail -n 1"],
  ["sort_head", "sort /data/a.txt | head -n 2"],
  ["sort_tail", "sort /data/a.txt | tail -n 2"],
  ["jq_sort", 'jq ".id" /data/data.jsonl | sort -n'],
  ["find_sort_head", 'find /data -name "*.txt" | sort | head -n 2'],

  ["cat_empty", "cat /data/empty.txt"],
  ["wc_empty", "wc /data/empty.txt"],
  ["head_empty", "head /data/empty.txt"],
  ["md5_empty", "md5 /data/empty.txt"],
  ["sha256_empty", "sha256sum /data/empty.txt"],
  ["cat_no_nl", "cat /data/no_nl.txt"],
  ["wc_no_nl", "wc /data/no_nl.txt"],
  ["md5_one_byte", "md5 /data/one_byte.txt"],
  ["wc_one_byte", "wc /data/one_byte.txt"],

  ["sort_u", "sort -u /data/dup.txt"],
  ["sort_k_t", "sort -k 2 -t , /data/csv.csv"],
  ["sort_f", "sort -f /data/mixed.txt"],
  ["sort_n_r", "sort -n -r /data/numbers.txt"],

  ["grep_w", "grep -w world /data/a.txt"],
  ["grep_count_no_match", "grep -c nothere /data/a.txt"],
  ["grep_n_v_combo", "grep -n -v foo /data/a.txt"],
  ["rg_c", "rg -c hello /data/mixed.txt"],

  ["find_d", "find /data -type d"],
  ["find_iname", 'find /data -iname "*.TXT"'],
  ["find_size_gt", "find /data -size +10c"],
  ["find_recurse", 'find /data -name "*.txt"'],
  ["find_path_pattern", 'find /data -path "*sub*"'],

  ["wc_m", "wc -m /data/a.txt"],
  ["wc_L", "wc -L /data/a.txt"],

  ["comm_12", "comm -12 /data/sorted_a.txt /data/sorted_b.txt"],
  ["comm_23", "comm -23 /data/sorted_a.txt /data/sorted_b.txt"],
  ["comm_13", "comm -13 /data/sorted_a.txt /data/sorted_b.txt"],

  ["tail_c", "tail -c 5 /data/a.txt"],

  ["sha256sum_multi", "sha256sum /data/a.txt /data/b.txt"],

  ["ls_sub", "ls /data/sub/"],
  ["cat_nested", "cat /data/sub/nested.txt"],
  ["find_depth2", "find /data/sub -type f"],

  ["pipe_grep_sort_uniq_wc", "grep -v c /data/dup.txt | sort | uniq | wc -l"],
  ["pipe_cat_cut_sort", "cat /data/csv.csv | cut -d , -f 2 | sort -n"],
  ["pipe_jq_grep", 'jq ".id" /data/data.jsonl | grep 2'],
  ["pipe_find_grep_wc", 'find /data -name "*.txt" | grep dup | wc -l'],
  ["pipe_cat_tr_sort_uniq", "cat /data/dup.txt | tr a-z A-Z | sort | uniq -c"],
  ["pipe_head_pipe_tail2", "head /data/numbers.txt | tail -n 2"],
  ["pipe_tail_head", "tail /data/a.txt | head -n 1"],

  ["md5_stdin", "echo hello | md5"],
  ["sha256_stdin", "echo hello | sha256sum"],
  ["base64_stdin", "echo hello | base64"],
  ["wc_stdin", "echo 'a b c' | wc"],

  ["awk_nf", "awk '{print NF}' /data/fields.txt"],
  ["awk_nr_total", "awk 'END{print NR}' /data/a.txt"],
  ["awk_last_col", "awk '{print $NF}' /data/fields.txt"],
  ["awk_if", "awk '$2 > 28' /data/fields.txt"],
  [
    "awk_begin_end",
    'awk \'BEGIN{print "start"} {print} END{print "done"}\' /data/b.txt',
  ],
  ["awk_fs_comma", "awk -F , '{print $2}' /data/csv.csv"],
  ["awk_ofs", "awk -F , 'BEGIN{OFS=\":\"} {print $1, $2}' /data/csv.csv"],
  ["awk_range", "awk 'NR>=2 && NR<=4' /data/a.txt"],

  ["sed_d_first", "sed 1d /data/a.txt"],
  ["sed_d_last", "sed '$d' /data/a.txt"],
  ["sed_range_p", "sed -n '2,3p' /data/a.txt"],
  ["sed_print_only", "sed -n '/world/p' /data/a.txt"],
  ["sed_replace_n", "sed 's/o/O/2' /data/a.txt"],
  ["sed_delete_pattern", "sed '/foo/d' /data/a.txt"],
  ["sed_append", "sed '2a\\\nINSERTED' /data/a.txt"],
  // Anchored ^/$ must apply per line (strukto-ai/mirage#326).
  ["sed_anchor_sub", "cat /data/anchors.txt | sed 's/^#[0-9]*$/#TS/'"],
  ["sed_anchor_sub_E", "cat /data/anchors.txt | sed -E 's/^#[0-9]+$/#TS/'"],
  ["sed_anchor_sub_g", "cat /data/anchors.txt | sed 's/^#[0-9]*$/#TS/g'"],
  ["sed_anchor_addr_del", "cat /data/anchors.txt | sed '/^#[0-9]*$/d'"],
  // Same per-line semantics must hold when sed reads a file argument
  // directly (single-`s` fast-path), not just stdin (strukto-ai/mirage#326).
  ["sed_anchor_sub_file", "sed 's/^#[0-9]*$/#TS/' /data/anchors.txt"],
  // Non-global `s///` replaces the first match on *each* line, not just the
  // first match in the whole file.
  ["sed_firstmatch_file", "sed 's/o/O/' /data/multi.txt"],
  // s/// numeric count (Nth occurrence) and Nth-onward (Ng), per line.
  ["sed_count_nth", "sed 's/o/O/2' /data/oooo.txt"],
  ["sed_count_nth_g", "sed 's/o/O/2g' /data/oooo.txt"],
  // s///p prints the pattern space on substitution (here with -n).
  ["sed_sub_p", "cat /data/oooo.txt | sed -n 's/o/O/p'"],
  // y/// transliterate, and the change command (single address + range).
  ["sed_y", "echo hello | sed 'y/el/ip/'"],
  ["sed_c_addr", "sed '2cCHANGED' /data/a.txt"],
  ["sed_c_range", "sed '2,4cMID' /data/a.txt"],
  // BRE (default): \\( \\) groups, \\+ one-or-more, \\| alternation (GNU exts);
  // bare + is literal. ERE via -E / -r: bare () + | are special.
  ['sed_bre_group', "echo foo | sed 's/\\(foo\\)/[\\1]/'"],
  ['sed_bre_plus', 'echo aaab | sed \'s/a\\+/X/\''],
  ['sed_bre_alt', "echo cat | sed 's/cat\\|dog/PET/'"],
  ['sed_ere_group', "echo foo | sed -E 's/(foo)/[\\1]/'"],
  ['sed_ere_plus', "echo aaab | sed -E 's/a+/X/'"],
  ['sed_r_alias', "echo aaab | sed -r 's/a+/X/'"],
  // Multiple -e expressions apply in sequence; -e with a file argument.
  ['sed_multi_e', "echo a | sed -e 's/a/b/' -e 's/b/c/'"],
  ['sed_e_file', 'sed -e s/world/EARTH/ /data/a.txt'],
  // -f reads the script from a file (script lives on the data mount). The
  // script file is created and removed inside the case so directory listings
  // stay unpolluted.
  [
    'sed_f_file',
    "echo 's/world/EARTH/' | tee /data/prog.sed > /dev/null && sed -f /data/prog.sed /data/a.txt && rm /data/prog.sed",
  ],
  [
    'sed_f_multi',
    "echo 's/world/EARTH/;s/foo/FOO/' | tee /data/prog.sed > /dev/null && sed -f /data/prog.sed /data/a.txt && rm /data/prog.sed",
  ],
  [
    'sed_ef_combined',
    "echo 's/foo/FOO/' | tee /data/prog.sed > /dev/null && sed -e s/world/EARTH/ -f /data/prog.sed /data/a.txt && rm /data/prog.sed",
  ],
  [
    'sed_f_stdin',
    "echo 's/world/EARTH/' | tee /data/prog.sed > /dev/null && cat /data/a.txt | sed -f /data/prog.sed && rm /data/prog.sed",
  ],
  // Broader GNU sed surface: & whole-match, s flags, addresses, hold/branch,
  // multi-command, alt delimiters, a/i/c forms.
  ['sed_amp', "sed 's/world/[&]/' /data/a.txt"],
  ['sed_amp_literal', "sed 's/world/[\\&]/' /data/a.txt"],
  ['sed_sub_i', "sed 's/hello/HI/i' /data/mixed.txt"],
  ['sed_delim_pipe', "sed 's|o|O|g' /data/a.txt"],
  ['sed_d_range', "sed '2,3d' /data/a.txt"],
  ['sed_n_2p', "sed -n '2p' /data/a.txt"],
  ['sed_n_lastp', "sed -n '$p' /data/a.txt"],
  ['sed_insert', "sed '2iINSERTED' /data/a.txt"],
  ['sed_change_all', "sed 'cX' /data/a.txt"],
  ['sed_change_regex', "sed '/world/cCHANGED' /data/a.txt"],
  ['sed_quit', "sed '2q' /data/a.txt"],
  ['sed_double_space', "sed 'G' /data/a.txt"],
  ['sed_n_join', "sed 'N;s/\\n/ /' /data/a.txt"],
  ['sed_block', "sed '/world/{s/world/W/;s/W/X/}' /data/a.txt"],
  ['sed_semicolon', "sed 's/o/0/;s/a/A/' /data/a.txt"],
  ['sed_backref_E', "sed -E 's/(section)([0-9])/\\2\\1/' /data/sections.txt"],
  // address negation: addr!cmd applies to lines the address does NOT select.
  ['sed_neg_line', "sed '2!d' /data/a.txt"],
  ['sed_neg_regex', "sed '/world/!d' /data/a.txt"],
  ['sed_neg_lastp', "sed -n '$!p' /data/a.txt"],
  ['sed_neg_range', "sed '1,3!s/./X/' /data/a.txt"],
  // multi-line pattern space: join-all idiom, hold accumulation, escaped
  // delimiter, and preservation of a missing final newline.
  ['sed_join_all', "sed ':a;N;$!ba;s/\\n/,/g' /data/a.txt"],
  ['sed_hold_accum', "sed -n 'H;${x;p}' /data/a.txt"],
  ['sed_escaped_delim', "echo 'a/b' | sed 's/a\\/b/c/'"],
  ['sed_no_final_nl', "sed 's/no/NO/' /data/no_nl.txt"],
  // a case arm runs every statement up to its ;; terminator
  ['case_multi_arm', 'case x in x) echo one; echo two;; esac'],
  ['case_multi_arm_default', 'case y in x) echo one;; *) echo fall; echo through;; esac'],

  ["tr_squeeze", "echo aaabbbccc | tr -s a-z"],
  ["tr_complement", "cat /data/a.txt | tr -c 'a-z\\n' '*'"],
  ["tr_delete_digits", "echo abc123def | tr -d 0-9"],
  ["tr_to_newlines", "echo 'a b c' | tr ' ' '\\n'"],

  ["cut_c1", "cut -c 1 /data/a.txt"],
  ["cut_c_range_open", "cut -c 3- /data/a.txt"],
  ["cut_d_space", "cut -d ' ' -f 2 /data/fields.txt"],
  ["cut_f1_3", "cut -d , -f 1,2 /data/csv.csv"],

  ["sort_t_comma", "sort -t , -k 1 /data/abc.csv"],
  ["sort_k2n", "sort -t ' ' -k 2 -n /data/fields.txt"],
  ["sort_M", "echo -e 'Feb\\nJan\\nMar' | sort -M"],
  ["sort_b", "sort -b /data/spaced.txt"],

  ["uniq_u", "uniq -u /data/dup.txt"],
  ["uniq_repeats", "uniq /data/repeats.txt"],
  ["uniq_c_repeats", "uniq -c /data/repeats.txt"],
  ["uniq_f", "uniq -f 1 /data/prefix_dup.txt"],
  ["uniq_s", "uniq -s 1 /data/prefix_dup.txt"],
  ["uniq_w", "uniq -w 3 /data/prefix_dup.txt"],
  ["uniq_w0", "uniq -w 0 /data/prefix_dup.txt"],
  ["uniq_f_c", "uniq -c -f 1 /data/prefix_dup.txt"],

  ["grep_F", "grep -F . /data/user.json"],
  ["grep_m1", "grep -m 1 o /data/a.txt"],
  ["grep_h", "grep -h hello /data/mixed.txt /data/a.txt"],
  ["grep_only_match_multi", "grep -o o /data/a.txt"],
  ["grep_recursive_dir", "grep -r hello /data/sub"],
  ["grep_empty_pattern", "grep '' /data/b.txt"],
  ["grep_e_flag", "grep -e world /data/a.txt"],
  ["grep_e_n", "grep -n -e bar /data/a.txt"],
  ["grep_e_multi_file", "grep -e hello /data/mixed.txt /data/a.txt"],
  ["grep_e_multi_pattern", "grep -e world -e bar /data/a.txt"],
  ["grep_e_multi_pattern_n", "grep -n -e hello -e baz /data/a.txt"],
  ["grep_e_multi_pattern_F", "grep -F -e a.b -e foo /data/a.txt"],
  ["grep_f_file", "grep -f /data/patterns.txt /data/a.txt"],
  ["grep_e_f_union", "grep -e hello -f /data/patterns.txt /data/a.txt"],
  ["grep_f_multi", "grep -f /data/patterns.txt -f /data/patterns2.txt /data/a.txt"],
  ["grep_cluster_ne", "grep -ne world /data/a.txt"],
  ["du_max_depth_eq", "du --max-depth=1 /data/sub"],
  ["grep_unknown_flag_ignored", "grep --color=auto world /data/a.txt"],
  ["grep_cluster_attached", "grep -neworld /data/a.txt"],
  ["grep_cluster_count", "grep -im1 l /data/mixed.txt"],
  ["rg_f_multi", "rg -f /data/patterns.txt -f /data/patterns2.txt /data/a.txt"],
  ["zgrep_e_multi_pipe", "cat /data/a.txt | gzip | zgrep -e world -e baz"],
  ["rg_e_flag", "rg -e world /data/a.txt"],
  ["rg_e_multi", "rg -e world -e bar /data/a.txt"],
  ["rg_f_file", "rg -f /data/patterns.txt /data/a.txt"],
  ["zgrep_f_pipe", "cat /data/a.txt | gzip | zgrep -f /data/patterns.txt"],

  ["paste_s", "paste -s /data/b.txt"],
  ["paste_d_comma", "paste -d , /data/a.txt /data/b.txt"],

  ["file_empty", "file /data/empty.txt"],
  ["file_binary", "file /data/binary.bin"],

  ["find_empty", "find /data -empty"],
  ["find_not_name", 'find /data -not -name "*.txt"'],
  ["find_name_start", "find /data -name data"],
  ["find_maxdepth_zero", "find /data -maxdepth 0"],
  ["find_mindepth_zero", "find /data -mindepth 0 -type d"],
  ["find_size_lt", "find /data -size -5c"],
  ["find_depth", "find /data -depth -type f"],
  ["find_mtime", "find /data -mtime +0 -o -mtime -1"],

  ["xxd_c4", "head -c 12 /data/a.txt | xxd -c 4"],
  ["xxd_g1", "head -c 8 /data/a.txt | xxd -g 1"],
  ["xxd_u", "head -c 8 /data/a.txt | xxd -u"],

  ["diff_same", "diff /data/a.txt /data/a.txt"],
  ["diff_differ", "diff /data/a.txt /data/b.txt"],
  ["diff_u", "diff -u /data/sorted_a.txt /data/sorted_b.txt"],
  [
    "diff_recursive",
    "mkdir -p /data/dr/x/sub /data/dr/y/sub" +
      " && echo aaa | tee /data/dr/x/a.txt > /dev/null" +
      " && echo AAA | tee /data/dr/y/a.txt > /dev/null" +
      " && echo keep | tee /data/dr/x/c.txt > /dev/null" +
      " && echo keep | tee /data/dr/y/c.txt > /dev/null" +
      " && echo deep1 | tee /data/dr/x/sub/d.txt > /dev/null" +
      " && echo deep2 | tee /data/dr/y/sub/d.txt > /dev/null" +
      " && echo L | tee /data/dr/x/leftonly.txt > /dev/null" +
      " && echo R | tee /data/dr/y/rightonly.txt > /dev/null" +
      " && diff -r /data/dr/x /data/dr/y",
  ],
  ["cmp_same", "cmp /data/a.txt /data/a.txt"],
  ["cmp_differ", "cmp /data/a.txt /data/b.txt"],

  ["du_file", "du /data/a.txt"],
  ["du_dir", "du /data"],
  ["du_h", "du -h /data/a.txt"],
  ["tree", "tree /data/sub"],

  ["iconv_id", "cat /data/a.txt | iconv -f utf-8 -t utf-8"],

  ["cat_E", "cat -E /data/a.txt"],
  ["cat_T", "cat -T /data/tabbed.txt"],
  ["cat_A", "cat -A /data/tabbed.txt"],
  ["nl_d_pipe", "nl -d ! /data/a.txt"],
  ["nl_w3", "nl -w 3 /data/a.txt"],

  ["column_n", "column -t /data/fields.txt"],
  ["join_t", "join -t , /data/abc.csv /data/abc.csv"],
  ["join_o", "join /data/sorted_a.txt /data/sorted_c.txt"],

  ["fmt_w10", "fmt -w 10 /data/c.txt"],
  ["fold_s", "fold -s -w 6 /data/a.txt"],
  ["fold_file", "fold -w 3 /data/a.txt"],
  ["fold_multi", "fold -w 4 /data/a.txt /data/b.txt"],
  ["fold_default", "fold /data/c.txt"],
  ["fold_s_spaces", "fold -s -w 8 /data/mixed.txt"],
  ["expand_t4", "expand -t 4 /data/tabbed.txt"],
  ["unexpand_all", "echo '    hi' | unexpand -a"],

  ["tac_nested", "tac /data/sub/nested.txt"],
  ["rev_b", "rev /data/b.txt"],

  ["ls_a", "ls -a /data/sub"],
  ["ls_R", "ls -R /data/sub"],
  ["ls_sub_deep", "ls /data/sub/deep"],

  ["zgrep_pipe", "cat /data/a.txt | gzip | zgrep world"],
  ["zgrep_e_pipe", "cat /data/a.txt | gzip | zgrep -e world"],
  ["gzip_c_pipe", "cat /data/b.txt | gzip -c | zcat"],

  ["jq_keys", 'jq "keys" /data/user.json'],
  ["jq_length", 'jq ". | length" /data/users.json'],
  ["jq_select", 'jq ".users[] | select(.age > 27)" /data/users.json'],
  ["jq_jsonl_select", 'jq "select(.id > 1)" /data/data.jsonl'],

  ["pipe_awk_sort", "awk '{print $2}' /data/fields.txt | sort -n"],
  ["pipe_grep_cut", "grep -v name /data/csv.csv | cut -d , -f 1"],
  ["pipe_sed_wc", "sed 's/hello/hi/g' /data/mixed.txt | wc -l"],
  ["pipe_find_xargs_cat", 'find /data/sub -name "*.txt" | sort | head -n 1'],
  [
    "pipe_tr_sort_uniq_c",
    "cat /data/dup.txt | tr a-z A-Z | sort | uniq -c | sort -n",
  ],

  ["md5_stdin_multi", "cat /data/a.txt | md5"],
  ["sha256_stdin_multi", "cat /data/a.txt | sha256sum"],
  ["wc_stdin_l", "cat /data/a.txt | wc -l"],
  ["sort_stdin", "cat /data/dup.txt | sort"],
  ["rev_stdin", "echo hello | rev"],
  ["base64_stdin_d", "echo aGVsbG8= | base64 -d"],

  // ----- argv dispatch: expanded names, xargs/timeout token safety -----
  ["var_command_name", "E=echo; $E hi"],
  ["var_command_mount", "C=cat; $C /data/a.txt"],
  ["quoted_command_name", '"cat" /data/a.txt'],
  ["xargs_initial_args", "echo c | xargs echo a b"],
  ["xargs_wc_initial_args", "echo /data/a.txt | xargs wc -l"],
  ["xargs_literal_input", "echo '$(echo pwned)' | xargs echo"],
  ["xargs_quote_char_input", 'echo "don\'t" | xargs echo'],
  ["timeout_basic", "timeout 5 echo hello"],
  ["timeout_quoted_arg", "timeout 5 echo 'a  b'"],

  // ----- glob rule: resolved by whoever consumes the word, once -----
  ["glob_unmatched_echo", "echo /data/*.nope"],
  ["glob_test_f", "test -f /data/one_b* && echo yes"],
  ["glob_function_args", "f() { echo $1 $#; }; f /data/sorted_*.txt"],
  ["glob_matched_echo", "echo /data/sorted_*.txt"],
  [
    "glob_pattern_dup_word",
    "mkdir -p /data/g8 && printf 'x *.txt y\\n' | tee /data/g8/l1.txt" +
      " > /dev/null && printf 'plain\\n' | tee /data/g8/l2.txt > /dev/null" +
      " && cd /data/g8 && grep -F '*.txt' *.txt" +
      " && cd / && rm -r /data/g8",
  ],
  ["redirect_bare_prep", "mkdir -p /data/g9 && cd /data/g9"],
  ["redirect_bare_target", "echo hi > OUT && cat OUT && cd / && rm -r /data/g9"],
  [
    "source_prep",
    "mkdir -p /data/g10 && cd /data/g10 && printf 'echo sourced-ok\\n' | tee lib.sh > /dev/null",
  ],
  ["source_relative", "source lib.sh && . /data/g10/lib.sh && cd / && rm -r /data/g10"],
  [
    "relative_operand_prep",
    "mkdir -p /data/g11/sub && cd /data/g11 && printf 'one\\ntwo\\n' | tee sub/README > /dev/null",
  ],
  ["relative_operand_extensionless", "cat sub/README && wc -l sub/README && head -1 sub/README"],
  ["redirect_relative_write", "echo one > sub/LOG"],
  ["redirect_relative_append", "echo two >> sub/LOG && cat sub/LOG"],
  ["redirect_stdin_relative", "wc -l < sub/LOG && cd / && rm -r /data/g11"],
  [
    "relword_prep",
    "mkdir -p /data/g12/sub && cd /data/g12 && printf 'y\n' | tee plain.txt > /dev/null" +
      " && printf 'x\n' | tee sub/a.txt > /dev/null && printf 'x\n' | tee sub/b.txt > /dev/null",
  ],
  [
    "test_relative_paths",
    "test -f plain.txt && echo yes-f && test -d sub && echo yes-d" +
      " && test -f missing.txt || echo no-f",
  ],
  ["glob_relative_display", "echo sub/*.txt && echo *.nope"],
  ["glob_relative_for", "for f in sub/*.txt; do echo $f; done"],
  ["glob_relative_func", "f() { echo $1 $#; }; f sub/*.txt && cd / && rm -r /data/g12"],
  [
    "redirect_after_cd",
    "mkdir -p /data/g13 && cd /data/g13 && echo hi > CDOUT && cat /data/g13/CDOUT",
  ],
  ["redirect_list_last_only", "echo one && echo two > captured && cat captured"],
  ["redirect_chain", "echo a > chain && echo b >> chain && cat chain && wc -l < chain"],
  ["redirect_group", "{ echo g1; echo g2; } > gout && cat gout && cd / && rm -r /data/g13"],
  [
    "relspell_prep",
    "mkdir -p /data/g14/sub && cd /data/g14" +
      " && printf 'hello\n' | tee sub/a.txt > /dev/null" +
      " && printf 'hello\n' | tee sub/b.txt > /dev/null",
  ],
  ["relspell_walk_grep", "grep -r hello sub"],
  ["relspell_walk_find", "find sub -name '*.txt'"],
  ["relspell_error_cat", "cat sub/missing.txt 2>&1"],
  ["relspell_error_grep", "grep hello sub/missing.txt 2>&1"],
  ["relspell_glob_dot", "echo ./sub/*.txt"],
  ["relspell_du_slash", "du -s sub/"],
  ["relspell_labels", "wc -l sub/a.txt && head -v sub/a.txt && cd / && rm -r /data/g14"],

  // ----- cp / mv multi-source into a directory (last; these mutate) -----
  ["cp_multi_into_dir", "cp /data/a.txt /data/b.txt /data/sub"],
  ["cp_multi_verify_a", "cat /data/sub/a.txt"],
  ["cp_multi_verify_b", "cat /data/sub/b.txt"],
  ["mv_multi_into_dir", "mv /data/sub/a.txt /data/sub/b.txt /data/sub/deep"],
  ["mv_multi_verify_a", "cat /data/sub/deep/a.txt"],
  ["mv_multi_verify_b", "cat /data/sub/deep/b.txt"],

  // ----- rg multi-path + columnar skip -----
  ["rg_multi_setup_d1", "mkdir -p /data/rgm/d1"],
  ["rg_multi_setup_d2", "mkdir -p /data/rgm/d2"],
  ["rg_multi_seed1", "cp /data/a.txt /data/rgm/d1/f1.txt"],
  ["rg_multi_seed2", "cp /data/mixed.txt /data/rgm/d2/f2.txt"],
  ["rg_multi_dir", "rg -i hello /data/rgm/d1 /data/rgm/d2"],
  ["rg_l_multi_file", "rg -l hello /data/rgm/d1/f1.txt /data/rgm/d2/f2.txt"],
  ["rg_col_seed_parquet", "cp /data/a.txt /data/rgm/d1/skip.parquet"],
  ["rg_columnar_skip", "rg world /data/rgm/d1"],
  // ----- archive file modes (generic gzip/tar/zip/split wrappers) -----
  [
    'arch_gzip_roundtrip',
    'mkdir -p /data/arch && echo gz-data | tee /data/arch/g.txt > /dev/null' +
      ' && gzip /data/arch/g.txt && gunzip /data/arch/g.txt.gz' +
      ' && cat /data/arch/g.txt && ls /data/arch',
  ],
  ['arch_tar_create_verbose', 'tar -c -v -z -f /data/arch/a.tgz /data/arch/g.txt'],
  ['arch_tar_list', 'tar -t -z -f /data/arch/a.tgz'],
  [
    'arch_tar_extract_strip',
    'tar -x -z -f /data/arch/a.tgz --strip-components 2 -C /data/arch/out' +
      ' && cat /data/arch/out/g.txt',
  ],
  [
    'arch_tar_exclude',
    'echo noise | tee /data/arch/skip.log > /dev/null' +
      " && tar -c -v -f /data/arch/b.tar --exclude '*.log'" +
      ' /data/arch/g.txt /data/arch/skip.log',
  ],
  ['arch_zip_unzip', 'zip -q /data/arch/z.zip /data/arch/g.txt && unzip -p /data/arch/z.zip'],
  [
    'arch_split_roundtrip',
    'split -b 4 /data/arch/g.txt /data/arch/pt_ && cat /data/arch/pt_aa /data/arch/pt_ab',
  ],
  [
    'arch_csplit',
    'cat /data/a.txt | tee /data/arch/c.txt > /dev/null' +
      ' && csplit -s -f /data/arch/cs_ /data/arch/c.txt /foo/' +
      ' && cat /data/arch/cs_00',
  ],
  ['arch_iconv_file', 'iconv -f utf-8 -t utf-8 /data/arch/g.txt'],
  ['arch_mktemp', 'mktemp -p /data/arch | wc -l'],

  // Quoted empty strings are real (empty) arguments, like bash.
  ['echo_empty_squote', "echo a '' b"],
  ['echo_empty_dquote', 'echo a "" b'],

  // ----- create at the mount root (parent resolves to "/") -----
  ['root_create', 'echo atroot | tee /data/at_root.txt'],
  ['root_create_cat', 'cat /data/at_root.txt'],
  ['root_create_mkdir', 'mkdir /data/rootdir && find /data/rootdir -type d'],
  ['root_create_basename', 'basename /data/at_root.txt'],
  ['root_create_dirname', 'dirname /data/at_root.txt'],

  // ----- cwd / relative paths / tilde / OLDPWD (GNU cd + pwd) -----
  // Each case is wrapped in a subshell so cwd/env changes do not leak
  // into later cases (the suite runs on one persistent session).
  ['cwd_pwd_root', '(pwd)'],
  ['cwd_cd_mount_pwd', '(cd /data && pwd)'],
  ['cwd_cd_subdir_pwd', '(cd /data/sub && pwd)'],
  ['cwd_cd_dotdot_pwd', '(cd /data/sub && cd .. && pwd)'],
  ['cwd_rel_cat', '(cd /data && cat a.txt)'],
  ['cwd_rel_dot_cat', '(cd /data && cat ./a.txt)'],
  ['cwd_rel_subdir_cat', '(cd /data && cat sub/nested.txt)'],
  ['cwd_rel_dotdot_cat', '(cd /data/sub && cat ../a.txt)'],
  [
    'cwd_rel_csplit',
    '(cd /data/sub && csplit -s -f cs_ nested.txt 2 && cat cs_00 cs_01 && rm cs_00 cs_01)',
  ],
  ['cwd_echo_pwd', '(cd /data/sub && echo $PWD)'],
  ['cwd_echo_home_unset', '(echo "[$HOME]")'],
  ['cwd_cd_oldpwd', '(cd /data && cd /data/sub && echo $OLDPWD)'],
  ['cwd_cd_dash', '(cd /data && cd /data/sub && cd -)'],
  ['cwd_cd_dash_pwd', '(cd /data && cd /data/sub && cd - > /dev/null && pwd)'],
  ['cwd_home_cd_tilde', '(export HOME=/data && cd ~ && pwd)'],
  ['cwd_home_echo', '(export HOME=/data && echo $HOME)'],
  ['cwd_tilde_cat', '(export HOME=/data && cat ~/a.txt)'],
  ['cwd_tilde_subdir_cat', '(export HOME=/data && cat ~/sub/nested.txt)'],
  // GNU cd: leading // collapses, -L/-P/-- options, $CDPATH search.
  ['cwd_cd_double_slash', '(cd //data && pwd)'],
  ['cwd_cd_phys_flag', '(cd -P /data/sub && pwd)'],
  ['cwd_cd_log_flag', '(cd -L /data && pwd)'],
  ['cwd_cd_dashdash', '(cd -- /data && pwd)'],
  ['cwd_cd_cdpath', '(export CDPATH=/data && cd sub && pwd)'],

  // ----- subshell isolation vs inheritance (GNU bash ( ... )) -----
  // A subshell inherits all parent state but its mutations (vars, export,
  // cd, functions, positional params) must not leak back to the parent.
  ['subshell_var_isolated', '(x=1; (x=2); echo $x)'],
  ['subshell_var_inherit', '(x=7; (echo $x))'],
  ['subshell_export_isolated', '(export Z=9); echo [$Z]'],
  ['subshell_func_redef', '(f(){ echo A; }; (f(){ echo B; }); f)'],
  ['subshell_func_no_leak', '(nofn(){ echo x; }); nofn 2>/dev/null || echo gone'],
  ['subshell_positional_isolated', '(set -- a b c; (set -- x); echo $#)'],
  ['subshell_positional_inherit', '(set -- a b; (echo $1 $2))'],
  ['subshell_cd_no_leak', '(cd /data); pwd'],
  ['subshell_nested_cd', '(cd /data && (cd /data/sub) && pwd)'],

  // ----- relative-path display: commands echo the arg as typed (GNU),
  // not the resolved absolute path -----
  ['disp_wc_rel', '(cd /data && wc -l a.txt)'],
  ['disp_wc_multi', '(cd /data && wc -l a.txt b.txt)'],
  ['disp_wc_dotslash', '(cd /data && wc -l ./a.txt)'],
  ['disp_wc_dotdot', '(cd /data/sub && wc -l ../a.txt)'],
  ['disp_grep_multi', '(cd /data && grep world a.txt b.txt)'],
  ['disp_md5_rel', '(cd /data && md5 a.txt)'],
  ['disp_stat_name', '(cd /data && stat -c %n a.txt)'],
  ['disp_find_subdir', '(cd /data && find sub -name nested.txt)'],
  ['disp_head_multi', '(cd /data && head -n 1 a.txt b.txt)'],
  ['disp_grep_files', '(cd /data && grep -l world a.txt b.txt)'],
  // traversal commands preserve the path form relative to the root
  ['disp_grep_r', '(cd /data && grep -r nested disptree)'],
  ['disp_rg_r', '(cd /data && rg nested disptree)'],
  ['disp_ls_recursive', '(cd /data && ls -R disptree)'],
  ['disp_find_root', '(cd /data && find disptree)'],

  // ----- history: recorder views over whatever observer store -----
  ['history_last_two', 'history 2'],
  ['bash_history_tail', "grep -v '^#' /.bash_history | tail -n 3"],
  ['history_find_view', 'find /.bash_history'],
  ['history_find_no_dir', 'find /.bash_history -type d'],
  ['bash_history_after_find', "grep -v '^#' /.bash_history | tail -n 1"],
  // GNU bash histfile layout: a `#<epoch>` comment line per command.
  // The timestamp is volatile, so normalize it to `#TS` to assert the
  // structure deterministically. The anchored pattern only matches lines
  // that consist solely of `#<digits>` (the timestamp comments).
  ['bash_history_format', "cat /.bash_history | sed 's/^#[0-9]*$/#TS/' | tail -n 4"],
  // gzip removes h.txt, the ls caches the listing, gunzip recreates h.txt:
  // cat and the final ls must see the recreated file, not stale cache.
  [
    'arch_gzip_interleaved_ls',
    'mkdir -p /data/arch2 && echo two | tee /data/arch2/h.txt > /dev/null' +
      ' && gzip /data/arch2/h.txt && ls /data/arch2' +
      ' && gunzip /data/arch2/h.txt.gz && cat /data/arch2/h.txt' +
      ' && ls /data/arch2',
  ],

  // ----- patch (apply / forward-only / reverse) -----
  ['patch_apply', 'patch -p1 /data/poem.diff > /dev/null && cat /data/poem.txt'],
  ['patch_n_noop', 'patch -N -p1 /data/poem.diff > /dev/null && cat /data/poem.txt'],
  ['patch_reverse', 'patch -R -p1 /data/poem.diff > /dev/null && cat /data/poem.txt'],
];

export const EXIT_CODE_CASES: ReadonlyArray<readonly [string, string]> = [
  // GNU cd error paths (stderr merged via 2>&1).
  ['cwd_cd_too_many', 'cd /data /data/sub 2>&1'],
  ['cwd_cd_bad_opt', 'cd -x /data 2>&1'],
  ['cwd_cd_home_unset', '(unset HOME; cd) 2>&1'],
  ['cwd_cd_quoted_tilde', "(cd /data && cd '~') 2>&1"],
  // sed rejects a zero occurrence count (GNU: "may not be zero").
  ["sed_count_zero", "sed 's/o/O/0'"],
  ["jq_no_filter_no_input", "jq"],
  ["jq_dot_no_input", 'jq "."'],
  ["tac_no_input", "tac"],
  ["xxd_no_input", "xxd"],
  ["column_no_input", "column"],
  ["strings_no_input", "strings"],
  ["tsort_no_input", "tsort"],
  ["base64_no_input", "base64"],
  ["split_no_input", "split"],
  ["iconv_no_input", "iconv"],
  ["bc_no_input", "bc"],
  ["tr_no_input", "tr a-z A-Z"],
  ["awk_no_input", "awk '{print}'"],
  ["sha256sum_no_input", "sha256sum"],
  ["patch_no_input", "patch"],
  ["look_no_input", "look foo"],
  ["zgrep_no_input", "zgrep foo"],
  ["gunzip_no_input", "gunzip"],
  ["zcat_no_input", "zcat"],
  ["gzip_d_no_input", "gzip -d"],
  ["csplit_no_input", "csplit"],
  ["gzip_no_input_roundtrip", "gzip | gunzip | sha256sum"],
  ["lazy_exit_grep_match", "grep hello /data/a.txt"],
  ["lazy_exit_grep_no_match", "grep zzz /data/a.txt"],
  ["grep_f_empty_no_match", "grep -f /data/empty.txt /data/a.txt"],
  ["grep_c_match_exit", "grep -c hello /data/a.txt"],
  ["grep_c_no_match_exit", "grep -c zzz /data/a.txt"],
  ["grep_c_stdin_no_match_exit", "echo hi | grep -c zzz"],
  ["grep_c_multi_no_match_exit", "grep -c zzz /data/a.txt /data/b.txt"],
  ["zgrep_c_match_exit", "echo hello | gzip | zgrep -c hello"],
  ["zgrep_c_no_match_exit", "echo hello | gzip | zgrep -c zzz"],
  ["grep_usage_exit", "grep"],
  ["rg_usage_exit", "rg"],
  ["zgrep_usage_exit", "zgrep"],
  ["grep_usage_no_input", "grep foo"],
  ["rg_usage_no_input", "rg foo"],
  ["grep_usage_stdin_only", "echo hi | grep"],
  ["cp_reject_multi_nondir", "cp /data/a.txt /data/b.txt /data/c.txt"],
  ["inv_ls_warm", "ls -1 /data/sub"],
  ["inv_touch", "touch /data/sub/inv_late.txt"],
  ["inv_rm", "rm /data/sub/inv_late.txt"],
  ["inv_gone", "cat /data/sub/inv_late.txt"],
  ["poison_concat", "cat /data/sorted_a.txt /data/sorted_b.txt"],
  ["poison_first_intact", "cat /data/sorted_a.txt"],
  ["poison_second_intact", "cat /data/sorted_b.txt"],
  ["pipe_concat_head_first", "cat /data/sorted_a.txt /data/sorted_b.txt | head -n 2"],
  ["pipe_concat_head_span", "cat /data/sorted_a.txt /data/sorted_b.txt | head -n 4"],
  ["pipe_after_first", "cat /data/sorted_a.txt"],
  ["pipe_after_second", "cat /data/sorted_b.txt"],
  ["lnzip_ls_warm", "ls -1 /data/sub"],
  ["ln_create", "ln -s /data/sub/nested.txt /data/sub/link.txt"],
  ["zip_create", "zip /data/sub/arch.zip /data/sub/nested.txt"],
  ["lnzip_ls_after", "ls -1 /data/sub"],
  ["ln_read_back", "readlink /data/sub/link.txt"],

  // ----- trailing-newline pins (wc -c counts the final \n) -----
  ["nl_pin_du", "du /data/b.txt | wc -c"],
  ["nl_pin_stat", "stat -c %n /data/b.txt | wc -c"],
  ["nl_pin_file", "file /data/b.txt | wc -c"],
  ["nl_pin_tree", "tree /data/sub | wc -c"],
  ["nl_pin_ls", "ls /data/sub | wc -c"],
  ["nl_pin_wc", "wc -l /data/b.txt | wc -c"],
  ["nl_pin_md5", "md5 /data/b.txt | wc -c"],
  ["nl_pin_cmp", "cmp /data/a.txt /data/b.txt | wc -c"],

  // ----- grep directory operands (GNU: warn on stderr, files still match) -----
  ["grep_dir_operand", "grep hello /data/sub"],
  ["grep_dir_among_files", "grep hello /data/a.txt /data/sub"],

  // ----- cp/mv coreutils guards (same-file, subtree, missing source) -----
  ["guard_cp_same_file", "cp /data/guard/g.txt /data/guard/g.txt"],
  ["guard_mv_same_file", "mv /data/guard/g.txt /data/guard/g.txt"],
  ["guard_mv_same_file_intact", "cat /data/guard/g.txt"],
  ["guard_mv_into_dir_where_file_lives", "mv /data/guard/sub/s.txt /data/guard/sub"],
  ["guard_cp_dir_into_itself", "cp -r /data/guard/sub /data/guard/sub"],
  ["guard_mv_dir_into_own_subtree", "mv /data/guard /data/guard/sub"],
  ["guard_cp_missing_source_continues", "cp /data/missing.txt /data/guard/g.txt /data/guard/sub"],
  ["guard_state_after", "find /data/guard -type f"],
  ["sleep_invalid", "sleep abc"],
  ["sleep_no_operand", "sleep"],
  ["sleep_negative", "sleep -1"],
  ["sleep_infinity", "sleep Infinity"],

  // ----- symlink follow-on-read (namespace links) -----
  ["sym_setup", "mkdir -p /data/symd && echo alpha > /data/symd/t.txt"],
  ["sym_ln", "ln -s /data/symd/t.txt /data/symd/l.txt"],
  ["sym_cat_follow", "cat /data/symd/l.txt"],
  ["sym_grep_follow", "grep alpha /data/symd/l.txt"],
  ["sym_write_through", "echo beta > /data/symd/l.txt && cat /data/symd/t.txt"],
  ["sym_ls_f", "ls -F /data/symd"],
  ["sym_ls_long_arrow", "ls -l /data/symd | grep -- '->'"],
  ["sym_dirlink_read", "ln -s /data/symd /data/dl && cat /data/dl/t.txt"],
  ["sym_mv_rename", "mv /data/symd/l.txt /data/symd/m.txt && readlink /data/symd/m.txt"],
  ["sym_cp_follow", "cp /data/symd/m.txt /data/symd/copy.txt && cat /data/symd/copy.txt"],
  ["sym_rm_link", "rm /data/symd/m.txt && readlink /data/symd/m.txt 2>&1"],
  ["sym_dangle_cat", "ln -s /data/symd/none /data/symd/dangle && cat /data/symd/dangle 2>&1"],
  ["sym_eloop_cat", "ln -s /data/lp2 /data/lp1 && ln -s /data/lp1 /data/lp2 && cat /data/lp1 2>&1"],
  ["sym_cleanup", "rm /data/symd/dangle /data/lp1 /data/lp2 /data/dl && rm -r /data/symd"],
];

// Invalid numeric/size/mtime arguments to find must exit 1 with a GNU-style
// message, identically across every backend (parsed before any backend I/O).
export const FIND_ARG_ERROR_CASES: ReadonlyArray<readonly [string, string]> = [
  ['find_bad_maxdepth', 'find /data -maxdepth abc'],
  ['find_bad_mindepth', 'find /data -mindepth xx'],
  ['find_bad_size', 'find /data -size abc'],
  ['find_empty_size', "find /data -size ''"],
  ['find_bad_mtime', 'find /data -mtime abc'],
  ['find_unknown_predicate', "find /data -regex '.*deep.*'"],
  ['find_bogus_predicate', 'find /data -boguspredicate'],
];

export const SLEEP_CASES: ReadonlyArray<readonly [string, string, number]> = [
  ["sleep_zero", "sleep 0", 0],
  ["sleep_fraction", "sleep 0.2", 0.2],
  ["sleep_one", "sleep 1", 1],
];

// Cross-mount coverage: every runner mounts a second resource of its own
// backend at /data2, so reads, writes, links, and provision spanning two
// mounts behave identically on every backend. Seeds happen inside the
// section (tee), so the /data listings earlier in the battery stay
// untouched.
export const CROSS_MOUNT_CASES: ReadonlyArray<readonly [string, string]> = [
  ["xm_seed", "echo cross | tee /data2/xm.txt"],
  ["xm_ls", "ls /data2"],
  ["xm_cat_concat", "cat /data/a.txt /data2/xm.txt"],
  ["xm_cp_over", "cp /data/a.txt /data2/xm_copy.txt && cat /data2/xm_copy.txt"],
  ["xm_cp_back", "cp /data2/xm.txt /data/xm_back.txt && cat /data/xm_back.txt"],
  ["xm_mv_over", "mv /data/xm_back.txt /data2/xm_moved.txt && cat /data2/xm_moved.txt && ls /data2"],
  ["xm_grep_multi", "grep -c s /data/a.txt /data2/xm.txt"],
  ["xm_wc_multi", "wc -l /data/a.txt /data2/xm.txt"],
  // du/md5/file fan out per mount and aggregate like the other readers
  ["xm_du_multi", "du /data/b.txt /data2/xm.txt"],
  ["xm_du_multi_total", "du -c /data/b.txt /data2/xm.txt"],
  ["xm_md5_multi", "md5 /data/b.txt /data2/xm.txt"],
  ["xm_file_multi", "file /data/a.txt /data2/xm.txt"],
  ["xm_find", "find /data2 -type f | sort"],
  ["xm_pipe", "cat /data2/xm.txt | tr a-z A-Z"],
  ["xm_ln_over", "ln -s /data/a.txt /data2/xm_link.txt && cat /data2/xm_link.txt"],
  ["xm_ln_readlink", "readlink /data2/xm_link.txt"],
  ["xm_ln_back", "ln -s /data2/xm.txt /data/xm_rlink.txt && cat /data/xm_rlink.txt"],
  ["xm_link_grep", "grep -c cross /data/xm_rlink.txt"],
  ["xm_cd_across", "(cd /data2 && cat xm.txt && cd /data && ls b.txt)"],
  // ----- STREAM strategy: cmd files == cat files | cmd -----
  ["xm_sort_stream", "sort /data/numbers.txt /data2/xm.txt"],
  ["xm_cat_n", "cat -n /data/b.txt /data2/xm.txt"],
  ["xm_cat_glob", "cat /data/sorted_*.txt /data2/xm.txt"],
  ["xm_nl", "nl /data/b.txt /data2/xm.txt"],
  ["xm_cut", "cut -c1 /data/a.txt /data2/xm.txt"],
  ["xm_sed_stream", "sed s/l/L/ /data/a.txt /data2/xm.txt"],
  ["xm_rev", "rev /data/b.txt /data2/xm.txt"],
  // ----- FANOUT strategy: one native run per operand -----
  ["xm_tac", "tac /data/b.txt /data2/xm.txt"],
  ["xm_grep_names", "grep -n o /data/a.txt /data2/xm.txt"],
  ["xm_grep_h", "grep -h o /data/a.txt /data2/xm.txt"],
  ["xm_head", "head -n 2 /data/a.txt /data2/xm.txt"],
  ["xm_tail", "tail -n 1 /data/a.txt /data2/xm.txt"],
  ["xm_tail_q", "tail -q -n 1 /data/a.txt /data2/xm.txt"],
  ["xm_wc_full", "wc /data/b.txt /data2/xm.txt"],
  ["xm_wc_glob", "wc -l /data/sorted_*.txt /data2/xm.txt"],
  ["xm_sha256", "sha256sum /data/b.txt /data2/xm.txt"],
  ["xm_strings", "strings /data/binary.bin /data2/xm.txt"],
  ["xm_ls_files", "ls /data/b.txt /data2/xm.txt"],
  ["xm_find_roots", "find /data/sub /data2 -name '*.txt'"],
  // ----- FANOUT writes: per-operand mutations on both mounts -----
  [
    "xm_touch_rm",
    "touch /data/xt.txt /data2/xt.txt" +
      " && ls /data/xt.txt /data2/xt.txt" +
      " && rm /data/xt.txt /data2/xt.txt && ls /data2",
  ],
  ["xm_mkdir_multi", "mkdir /data/xd /data2/xd && ls /data2 && rm -r /data/xd /data2/xd"],
  [
    "xm_tee_multi",
    "echo dual | tee /data/xdual.txt /data2/xdual.txt" +
      " && cat /data/xdual.txt /data2/xdual.txt" +
      " && rm /data/xdual.txt /data2/xdual.txt",
  ],
  [
    "xm_sed_inplace",
    "echo abc | tee /data/xi.txt /data2/xi.txt > /dev/null" +
      " && sed -i s/b/B/ /data/xi.txt /data2/xi.txt" +
      " && cat /data/xi.txt /data2/xi.txt" +
      " && rm /data/xi.txt /data2/xi.txt",
  ],
  ["xm_rg_count", "rg -c o /data/a.txt /data2/xm.txt"],
  ["xm_head_q", "head -q -n 1 /data/a.txt /data2/xm.txt"],
  ["xm_ls_multi", "ls /data/sub /data2"],
];

// Exit codes matter here (grep no-match merge, diff/cmp differ), so these
// print like EXIT_CODE_CASES.
export const CROSS_MOUNT_EXIT_CASES: ReadonlyArray<readonly [string, string]> = [
  ["xm_grep_nomatch", "grep zzz /data/a.txt /data2/xm.txt"],
  [
    "xm_diff_differ",
    "printf 'same\\nold\\n' | tee /data/xdiff.txt > /dev/null" +
      " && printf 'same\\nnew\\n' | tee /data2/xdiff.txt > /dev/null" +
      " && diff /data/xdiff.txt /data2/xdiff.txt",
  ],
  ["xm_cmp_differ", "cmp /data/xdiff.txt /data2/xdiff.txt"],
  [
    "xm_cmp_equal",
    "cp /data/xdiff.txt /data2/xsame.txt" +
      " && cmp /data/xdiff.txt /data2/xsame.txt" +
      " && rm /data/xdiff.txt /data2/xdiff.txt /data2/xsame.txt",
  ],
];

// Non-whitelisted commands spanning mounts must refuse with the shared
// message, pinning the whitelist boundary; printed like NOT_FOUND_CASES.
export const CROSS_MOUNT_ERR_CASES: ReadonlyArray<readonly [string, string]> = [
  ["xm_refuse_paste", "paste /data/a.txt /data2/xm.txt"],
];

// Provision (dry-run cost estimates) must print identical numbers on every
// backend: sizes come from seeded files, and the file cache is cleared first
// so read-caching backends (s3, onedrive, nextcloud) report the same cold
// numbers as non-caching ones (ram, disk, redis, ssh). Cache-hit flipping is
// backend-dependent and covered by runProvisionCacheCases instead.
export const PROVISION_CASES: ReadonlyArray<readonly [string, string]> = [
  // ----- whole-file readers (exact byte totals) -----
  ["prov_cat", "cat /data/a.txt"],
  ["prov_cat_multi", "cat /data/a.txt /data/b.txt"],
  ["prov_wc", "wc -l /data/a.txt"],
  ["prov_sort", "sort /data/numbers.txt"],
  ["prov_md5", "md5 /data/b.txt"],
  // ----- search family (worst-case full read) -----
  ["prov_grep", "grep world /data/a.txt"],
  ["prov_grep_multi", "grep hello /data/a.txt /data/mixed.txt"],
  ["prov_rg", "rg world /data/a.txt"],
  // ----- partial readers (range unless -c pins the bytes) -----
  ["prov_head", "head /data/a.txt"],
  ["prov_head_c", "head -c 5 /data/a.txt"],
  ["prov_tail", "tail -n 1 /data/a.txt"],
  // ----- metadata-only (op counts, no content bytes) -----
  ["prov_ls", "ls /data"],
  ["prov_find", 'find /data -name "*.txt"'],
  ["prov_du", "du /data/a.txt"],
  ["prov_stat", "stat /data/a.txt"],
  // ----- jq (streamable jsonl reads a range, object reads it all) -----
  ["prov_jq_object", 'jq ".name" /data/user.json'],
  ["prov_jq_jsonl", 'jq ".id" /data/data.jsonl'],
  // ----- honest degradation -----
  ["prov_missing", "cat /data/missing.txt"],
  ["prov_sed", "sed s/a/b/ /data/a.txt"],
  ["prov_sed_inplace", "sed -i s/a/b/ /data/a.txt"],
  ["prov_write", "tee /data/prov_out.txt"],
  // ----- combinators -----
  ["prov_pipe", "cat /data/a.txt | head -c 4"],
  ["prov_pipe_floor", "grep world /data/a.txt | wc -l"],
  ["prov_and", "cat /data/a.txt && cat /data/b.txt"],
  ["prov_seq", "cat /data/a.txt; cat /data/b.txt"],
  ["prov_or", "cat /data/b.txt || cat /data/a.txt"],
  ["prov_for", "for i in 1 2 3; do cat /data/a.txt; done"],
  ["prov_while", "while true; do cat /data/a.txt; done"],
  // ----- graceful defaults for the remaining families -----
  ["prov_file_cmd", "file /data/a.txt"],
  ["prov_iconv", "iconv -f utf-8 -t utf-8 /data/a.txt"],
  ["prov_cp", "cp /data/a.txt /data/sub"],
  ["prov_gzip", "gzip /data/b.txt"],
  ["prov_rm", "rm /data/dup.txt"],
  ["prov_rm_r", "rm -r /data/guard"],
  ["prov_mkdir", "mkdir /data/provdir"],
  ["prov_mv", "mv /data/a.txt /data/moved.txt"],
  ["prov_seq", "seq 3"],
  ["prov_date", "date"],
  // ----- complex bash aggregation -----
  ["prov_pipe3", "cat /data/a.txt | grep hello | wc -l"],
  ["prov_and_or", "cat /data/a.txt && cat /data/b.txt || cat /data/numbers.txt"],
  ["prov_or_and", "cat /data/a.txt || cat /data/b.txt && cat /data/numbers.txt"],
  ["prov_if_else", "if true; then cat /data/a.txt; else cat /data/b.txt; fi"],
  ["prov_if_cond_read", "if grep -q hello /data/a.txt; then cat /data/b.txt; fi"],
  ["prov_case", "case x in x) cat /data/a.txt;; *) cat /data/b.txt;; esac"],
  ["prov_subshell", "(cat /data/a.txt; cat /data/b.txt)"],
  ["prov_brace_group", "{ cat /data/a.txt; cat /data/b.txt; }"],
  ["prov_negate", "! grep zzz /data/a.txt"],
  ["prov_redirect_out", "cat /data/a.txt > /data/prov_redir.txt"],
  ["prov_or_unknown_branch", "tee /data/prov_x.txt || cat /data/a.txt"],
  ["prov_for_pipe", "for i in 1 2; do cat /data/a.txt | wc -l; done"],
  ["prov_for_nested", "for i in 1 2; do for j in 1 2; do cat /data/b.txt; done; done"],
  ["prov_cmdsub", "cat $(echo /data/a.txt)"],
  ["prov_deep_mix", "for i in 1 2; do cat /data/a.txt | wc -l && cat /data/b.txt; done"],
  // ----- planner/executor drift fixes (env prefix, functions, eval,
  // select/until, redirect costing) -----
  ["prov_env_prefix", "FOO=1 cat /data/a.txt"],
  ["prov_func_call", "pfn() { cat /data/b.txt; }; pfn; pfn"],
  ["prov_func_recursive", "prec() { prec; }; prec"],
  ["prov_eval", "eval 'cat /data/a.txt'"],
  ["prov_select", "select x in a b; do cat /data/a.txt; done"],
  ["prov_until", "until false; do cat /data/a.txt; done"],
  ["prov_redirect_in", "wc -l < /data/a.txt"],
  ["prov_redirect_devnull", "cat /data/a.txt > /dev/null"],
  // ----- namespace links and cross-mount commands -----
  ["prov_symlink", "cat /data2/xm_link.txt"],
  ["prov_symlink_grep", "grep x /data/xm_rlink.txt"],
  ["prov_xmount_concat", "cat /data/a.txt /data2/xm.txt"],
  ["prov_xmount_grep", "grep s /data/a.txt /data2/xm.txt"],
  ["prov_xmount_pipe", "cat /data/a.txt /data2/xm.txt | wc -c"],
  // md5 fans out per mount, so its plan sums per-mount estimates
  ["prov_xmount_md5", "md5 /data/a.txt /data2/xm.txt"],
  ["prov_xmount_du", "du /data/a.txt /data2/xm.txt"],
  // ----- glob + recursive expansion (readdir/index-driven) -----
  ["prov_glob", "cat /data/rgm/d1/*.txt"],
  ["prov_glob_unmatched", "cat /data/rgm/d1/*.nope"],
  ["prov_grep_r", "grep -r hello /data/rgm"],
  // ----- stdin-driven stages cost zero backend bytes -----
  ["prov_pathless", "wc -l"],
  ["prov_heredoc", "wc -c <<EOF\nhello\nEOF"],
  // ----- suppressed substitutions stay honest floors -----
  ["prov_for_cmdsub", "for i in $(echo 1 2); do cat /data/a.txt; done"],
  ["prov_redirect_cmdsub", "cat /data/a.txt > $(echo /data/prov_out.txt)"],
];

// Not-found errors must always show the full virtual path the user typed
// (mount prefix included) plus the GNU strerror, identically across backends
// and languages. Each case prints exit code and stderr.
export const NOT_FOUND_CASES: ReadonlyArray<readonly [string, string]> = [
  ["nf_cat", "cat /data/missing.txt"],
  ["nf_head", "head /data/missing.txt"],
  ["nf_tail", "tail /data/missing.txt"],
  ["nf_wc", "wc /data/missing.txt"],
  ["nf_stat", "stat /data/missing.txt"],
  ["nf_grep", "grep x /data/missing.txt"],
  ["nf_cat_nested", "cat /data/sub/missing.txt"],
  ["nf_cat_pipe", "cat /data/missing.txt | cat"],
  ["nf_cat_rel", "(cd /data && cat missing.txt)"],
  ["nf_cat_rel_subdir", "(cd /data && cat sub/missing.txt)"],
  ["nf_grep_r_rel", "(cd /data && grep -r x missing)"],
  // glob rule: unknown names 127 before backend work; GNU ln
  // multi-source refusal after expansion
  ["unknown_command", "nosuchcmd /data/a.txt"],
  ["glob_ln_multi_source", "ln -s /data/sorted_*.txt /data/lnk_multi"],
];

const ENC = new TextEncoder();

// Backend-agnostic not-found probe: every backend (whatever its mount prefix)
// must surface the full virtual path plus the GNU strerror. Read-only SaaS/DB
// backends call runNotFound(ws, MOUNT) so the same invariant is checked there.
const NOT_FOUND_PROGS: ReadonlyArray<readonly [string, string]> = [
  ["nf_cat", "cat"],
  ["nf_head", "head"],
  ["nf_tail", "tail"],
  ["nf_wc", "wc"],
  ["nf_stat", "stat"],
  ["nf_grep", "grep x"],
];

export async function runNotFound(ws: Workspace, mount: string): Promise<void> {
  const target = `${mount.replace(/\/+$/, "")}/__nf_missing__.txt`;
  for (const [name, prog] of NOT_FOUND_PROGS) {
    const result = await ws.execute(`${prog} ${target}`);
    const err = new TextDecoder().decode(result.stderr).trim();
    process.stdout.write(`=== ${name} ===\n`);
    process.stdout.write(`exit=${result.exitCode}\n`);
    if (err) process.stdout.write(err + "\n");
  }
}

// Emit a case's stdout. A non-empty body that does not end in a newline is
// flagged with a git-style sentinel so truth.txt records the missing final
// newline (otherwise the section separators would mask it).
function emitBody(out: string): void {
  if (out === "") {
    process.stdout.write("\n");
  } else if (out.endsWith("\n")) {
    process.stdout.write(out);
  } else {
    process.stdout.write(out + "\n\\ No newline at end of output\n");
  }
}

export async function runCases(ws: Workspace): Promise<void> {
  for (const [path, content] of Object.entries(SEED_FILES)) {
    const dir = path.slice(0, path.lastIndexOf("/"));
    await ws.execute(`mkdir -p ${dir}`);
    await ws.execute(`tee ${path} > /dev/null`, { stdin: ENC.encode(content) });
  }
  for (const [name, cmd] of CASES) {
    let out = "";
    try {
      const result = await ws.execute(cmd);
      out = new TextDecoder().decode(result.stdout);
    } catch (err) {
      process.stderr.write(
        `# ${name}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    process.stdout.write(`=== ${name} ===\n`);
    emitBody(out);
  }

  for (const [name, cmd] of EXIT_CODE_CASES) {
    const result = await ws.execute(cmd);
    const out = new TextDecoder().decode(result.stdout);
    process.stdout.write(`=== ${name} ===\n`);
    process.stdout.write(`exit=${result.exitCode}\n`);
    if (out) emitBody(out);
  }

  for (const [name, cmd] of NOT_FOUND_CASES) {
    const result = await ws.execute(cmd);
    const err = new TextDecoder().decode(result.stderr).trim();
    process.stdout.write(`=== ${name} ===\n`);
    process.stdout.write(`exit=${result.exitCode}\n`);
    if (err) process.stdout.write(err + "\n");
  }

  for (const [name, cmd] of FIND_ARG_ERROR_CASES) {
    const result = await ws.execute(cmd);
    const err = new TextDecoder().decode(result.stderr).trim();
    process.stdout.write(`=== ${name} ===\n`);
    process.stdout.write(`exit=${result.exitCode}\n`);
    if (err) process.stdout.write(err + "\n");
  }

  for (const [name, cmd, expected] of SLEEP_CASES) {
    const start = performance.now();
    const result = await ws.execute(cmd);
    const elapsed = (performance.now() - start) / 1000;
    process.stdout.write(`=== ${name} ===\n`);
    if (result.exitCode === 0 && elapsed >= expected - 0.05 && elapsed < expected + 2) {
      process.stdout.write(`${name} ok\n`);
    } else {
      process.stdout.write(`${name} FAIL exit=${result.exitCode} elapsed=${elapsed.toFixed(3)}\n`);
    }
  }

  for (const [name, cmd] of CROSS_MOUNT_CASES) {
    const result = await ws.execute(cmd);
    const out = new TextDecoder().decode(result.stdout);
    process.stdout.write(`=== ${name} ===\n`);
    emitBody(out);
  }

  for (const [name, cmd] of CROSS_MOUNT_EXIT_CASES) {
    const result = await ws.execute(cmd);
    const out = new TextDecoder().decode(result.stdout);
    process.stdout.write(`=== ${name} ===\n`);
    process.stdout.write(`exit=${result.exitCode}\n`);
    if (out) emitBody(out);
  }

  for (const [name, cmd] of CROSS_MOUNT_ERR_CASES) {
    const result = await ws.execute(cmd);
    const err = new TextDecoder().decode(result.stderr).trim();
    process.stdout.write(`=== ${name} ===\n`);
    process.stdout.write(`exit=${result.exitCode}\n`);
    if (err) process.stdout.write(err + "\n");
  }

  await runProvisionCases(ws);
}

function provisionLine(result: ProvisionResult): string {
  return (
    `net=${result.networkRead} write=${result.networkWrite} ` +
    `cache=${result.cacheRead} ops=${String(result.readOps)} ` +
    `hits=${String(result.cacheHits)} precision=${result.precision}`
  );
}

export async function runProvisionCases(ws: Workspace): Promise<void> {
  await ws.cache.clear();
  for (const [name, cmd] of PROVISION_CASES) {
    const result = await ws.execute(cmd, { provision: true });
    process.stdout.write(`=== ${name} ===\n`);
    process.stdout.write(provisionLine(result) + "\n");
  }
}

// Provision probe for bespoke suites: one file read, one search, one
// listing. Rendered/virtual files without a backend size print UNKNOWN
// floors; files with real sizes print exact totals.
export async function runProvisionProbe(ws: Workspace, filePath: string): Promise<void> {
  const parent = filePath.slice(0, filePath.lastIndexOf("/")) || "/";
  const probes: ReadonlyArray<readonly [string, string]> = [
    ["prov_probe_cat", `cat ${filePath}`],
    ["prov_probe_grep", `grep x ${filePath}`],
    ["prov_probe_ls", `ls ${parent}`],
  ];
  for (const [name, cmd] of probes) {
    const result = await ws.execute(cmd, { provision: true });
    process.stdout.write(`=== ${name} ===\n`);
    process.stdout.write(provisionLine(result) + "\n");
  }
}

async function backendBytes(ws: Workspace, cmd: string): Promise<number> {
  const before = ws.records.reduce((sum, r) => sum + r.bytes, 0);
  await ws.execute(cmd);
  return ws.records.reduce((sum, r) => sum + r.bytes, 0) - before;
}

// Byte-accounted cache verification for read-caching backends. A second
// read of the same file pulls zero backend bytes, whether it goes through
// the file's own path or a symlink (the link and its target share one
// cache entry), and provision reports the hit. With a second mount, the
// same holds for a cross-mount link, and the cross-mount cp is pinned
// as-is (it does not read through the cache today).
export async function runCacheVerifyCases(
  ws: Workspace,
  mount = "/data",
  mount2: string | null = null,
): Promise<void> {
  const m = mount.replace(/\/+$/, "");
  const target = `${m}/cachev.txt`;
  const link = `${m}/cachev_link.txt`;
  await ws.execute(`tee ${target} > /dev/null`, { stdin: ENC.encode("cache verify\n") });
  await ws.execute(`ln -s ${target} ${link}`);
  await ws.cache.clear();
  process.stdout.write("=== cachev_link_cold ===\n");
  process.stdout.write(`bytes=${String(await backendBytes(ws, `cat ${link}`))}\n`);
  process.stdout.write("=== cachev_link_warm ===\n");
  process.stdout.write(`bytes=${String(await backendBytes(ws, `cat ${link}`))}\n`);
  process.stdout.write("=== cachev_target_shares_entry ===\n");
  process.stdout.write(`bytes=${String(await backendBytes(ws, `cat ${target}`))}\n`);
  process.stdout.write("=== cachev_warm_grep ===\n");
  process.stdout.write(`bytes=${String(await backendBytes(ws, `grep cache ${target}`))}\n`);
  process.stdout.write("=== cachev_prov_link ===\n");
  let result = await ws.execute(`cat ${link}`, { provision: true });
  process.stdout.write(provisionLine(result) + "\n");
  if (mount2 !== null) {
    const m2 = mount2.replace(/\/+$/, "");
    const xlink = `${m2}/cachev_xlink.txt`;
    await ws.execute(`ln -s ${target} ${xlink}`);
    await ws.cache.clear();
    process.stdout.write("=== cachev_xmount_cold ===\n");
    process.stdout.write(`bytes=${String(await backendBytes(ws, `cat ${xlink}`))}\n`);
    process.stdout.write("=== cachev_xmount_warm ===\n");
    process.stdout.write(`bytes=${String(await backendBytes(ws, `cat ${xlink}`))}\n`);
    process.stdout.write("=== cachev_xmount_prov ===\n");
    result = await ws.execute(`cat ${xlink}`, { provision: true });
    process.stdout.write(provisionLine(result) + "\n");
    process.stdout.write("=== cachev_xmount_cp_warm_source ===\n");
    process.stdout.write(
      `bytes=${String(await backendBytes(ws, `cp ${target} ${m2}/cachev_cp.txt`))}\n`,
    );
    await ws.cache.clear();
    process.stdout.write("=== cachev_xmount_cp_cold_populates ===\n");
    process.stdout.write(
      `bytes=${String(await backendBytes(ws, `cp ${target} ${m2}/cachev_cp2.txt`))}\n`,
    );
    process.stdout.write("=== cachev_cat_after_cp ===\n");
    process.stdout.write(`bytes=${String(await backendBytes(ws, `cat ${target}`))}\n`);
  }
  await ws.execute(`rm ${link} ${target}`);
}

// Cache-hit flipping for read-caching backends (cachesReads=true). Once a
// path is in the file cache, provision reports the bytes as cache_read
// instead of network_read. Both populate routes are covered: write-through
// (tee) and read-through (a real cat).
export async function runProvisionCacheCases(ws: Workspace, mount = "/data"): Promise<void> {
  const m = mount.replace(/\/+$/, "");
  const a = `${m}/provcache.txt`;
  const b = `${m}/provcache_b.txt`;
  await ws.execute(`tee ${a} > /dev/null`, { stdin: ENC.encode("cache flip probe\n") });
  await ws.execute(`tee ${b} > /dev/null`, { stdin: ENC.encode("second file\n") });
  process.stdout.write("=== prov_cache_write_through ===\n");
  let result = await ws.execute(`cat ${a}`, { provision: true });
  process.stdout.write(provisionLine(result) + "\n");
  await ws.cache.clear();
  process.stdout.write("=== prov_cache_cold ===\n");
  result = await ws.execute(`cat ${a}`, { provision: true });
  process.stdout.write(provisionLine(result) + "\n");
  await ws.execute(`cat ${a} > /dev/null`);
  process.stdout.write("=== prov_cache_read_through ===\n");
  result = await ws.execute(`cat ${a}`, { provision: true });
  process.stdout.write(provisionLine(result) + "\n");
  // A single cached path flips the whole command's estimate: hits counts
  // cached paths, the byte split is not per-path.
  process.stdout.write("=== prov_cache_partial ===\n");
  result = await ws.execute(`cat ${a} ${b}`, { provision: true });
  process.stdout.write(provisionLine(result) + "\n");
  await ws.cache.clear();
  process.stdout.write("=== prov_cache_cleared ===\n");
  result = await ws.execute(`cat ${a}`, { provision: true });
  process.stdout.write(provisionLine(result) + "\n");
  await ws.execute(`rm ${a} ${b}`);
}

// Pure assertion (no stdout, not in truth.txt): a backend that reports real
// timestamps must surface them through `ls -l`, not the epoch sentinel. Writes
// a probe, drops the write-through cache so the listing resolves mtime from the
// backend stat, then checks both the file and the parent-dir listing.
export async function assertRealMtime(ws: Workspace): Promise<void> {
  const DEC = new TextDecoder();
  await ws.execute("mkdir -p /data/mtimecheck");
  await ws.execute("tee /data/mtimecheck/probe.txt > /dev/null", {
    stdin: ENC.encode("x"),
  });
  await ws.cache.clear();
  const fileOut = DEC.decode((await ws.execute("ls -l /data/mtimecheck/probe.txt")).stdout);
  const dirOut = DEC.decode((await ws.execute("ls -l /data | grep mtimecheck")).stdout);
  for (const [label, out] of [
    ["file", fileOut],
    ["dir", dirOut],
  ] as const) {
    if (out.trim() === "") throw new Error(`mtime check produced no ${label} listing`);
    if (out.includes("Jan  1 00:00"))
      throw new Error(
        `${label} ls -l shows epoch mtime (modified not set): ${JSON.stringify(out.trim())}`,
      );
  }
  await ws.execute("rm -rf /data/mtimecheck");
}
