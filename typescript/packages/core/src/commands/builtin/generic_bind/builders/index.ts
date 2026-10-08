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

import type { GenericCommand } from '../adapter.ts'
import * as awk from './awk.ts'
import * as base64 from './base64.ts'
import * as basename from './basename.ts'
import * as cat from './cat.ts'
import * as cmp from './cmp.ts'
import * as column from './column.ts'
import * as comm from './comm.ts'
import * as cp from './cp.ts'
import * as csplit from './csplit.ts'
import * as cut from './cut.ts'
import * as diff from './diff.ts'
import * as dirname from './dirname.ts'
import * as du from './du.ts'
import * as expand from './expand.ts'
import * as file from './file.ts'
import * as find from './find.ts'
import * as fmt from './fmt.ts'
import * as fold from './fold.ts'
import * as grep from './grep.ts'
import * as gunzip from './gunzip.ts'
import * as gzip from './gzip.ts'
import * as head from './head.ts'
import * as iconv from './iconv.ts'
import * as join from './join.ts'
import * as jq from './jq.ts'
import * as look from './look.ts'
import * as ls from './ls.ts'
import * as md5 from './md5.ts'
import * as md5sum from './md5sum.ts'
import * as mkdir from './mkdir.ts'
import * as mktemp from './mktemp.ts'
import * as mv from './mv.ts'
import * as nl from './nl.ts'
import * as numfmt from './numfmt.ts'
import * as od from './od.ts'
import * as paste from './paste.ts'
import * as patch from './patch.ts'
import * as readlink from './readlink.ts'
import * as realpath from './realpath.ts'
import * as rev from './rev.ts'
import * as rg from './rg.ts'
import * as rm from './rm.ts'
import * as rmdir from './rmdir.ts'
import * as sed from './sed.ts'
import * as sha1sum from './sha1sum.ts'
import * as sha256sum from './sha256sum.ts'
import * as sha384sum from './sha384sum.ts'
import * as sha512sum from './sha512sum.ts'
import * as shuf from './shuf.ts'
import * as sort from './sort.ts'
import * as split from './split.ts'
import * as stat from './stat.ts'
import * as strings from './strings.ts'
import * as tac from './tac.ts'
import * as tail from './tail.ts'
import * as tar from './tar.ts'
import * as tee from './tee.ts'
import * as touch from './touch.ts'
import * as truncate from './truncate.ts'
import * as tr from './tr.ts'
import * as tree from './tree.ts'
import * as tsort from './tsort.ts'
import * as unexpand from './unexpand.ts'
import * as uniq from './uniq.ts'
import * as unlink from './unlink.ts'
import * as unzip from './unzip.ts'
import * as wc from './wc.ts'
import * as xxd from './xxd.ts'
import * as zcat from './zcat.ts'
import * as zgrep from './zgrep.ts'
import * as zipCmd from './zip_cmd.ts'

export const BUILDERS: readonly GenericCommand[] = [
  awk.BUILDER,
  base64.BUILDER,
  basename.BUILDER,
  cat.BUILDER,
  cmp.BUILDER,
  column.BUILDER,
  comm.BUILDER,
  cp.BUILDER,
  csplit.BUILDER,
  cut.BUILDER,
  diff.BUILDER,
  dirname.BUILDER,
  du.BUILDER,
  expand.BUILDER,
  file.BUILDER,
  find.BUILDER,
  fmt.BUILDER,
  fold.BUILDER,
  grep.BUILDER,
  gunzip.BUILDER,
  gzip.BUILDER,
  head.BUILDER,
  iconv.BUILDER,
  join.BUILDER,
  jq.BUILDER,
  look.BUILDER,
  ls.BUILDER,
  md5.BUILDER,
  md5sum.BUILDER,
  mkdir.BUILDER,
  mktemp.BUILDER,
  mv.BUILDER,
  nl.BUILDER,
  numfmt.BUILDER,
  od.BUILDER,
  paste.BUILDER,
  patch.BUILDER,
  readlink.BUILDER,
  realpath.BUILDER,
  rev.BUILDER,
  rg.BUILDER,
  rm.BUILDER,
  rmdir.BUILDER,
  sed.BUILDER,
  sha1sum.BUILDER,
  sha256sum.BUILDER,
  sha384sum.BUILDER,
  sha512sum.BUILDER,
  shuf.BUILDER,
  sort.BUILDER,
  split.BUILDER,
  stat.BUILDER,
  strings.BUILDER,
  tac.BUILDER,
  tail.BUILDER,
  tar.BUILDER,
  tee.BUILDER,
  touch.BUILDER,
  truncate.BUILDER,
  tr.BUILDER,
  tree.BUILDER,
  tsort.BUILDER,
  unexpand.BUILDER,
  uniq.BUILDER,
  unlink.BUILDER,
  unzip.BUILDER,
  wc.BUILDER,
  xxd.BUILDER,
  zcat.BUILDER,
  zgrep.BUILDER,
  zipCmd.BUILDER,
]
