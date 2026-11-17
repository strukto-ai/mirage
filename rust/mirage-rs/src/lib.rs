pub mod arith;
mod awk;
mod base64;
mod bc;
mod block_size;
mod calendar;
mod cat;
pub mod cli;
mod cmp;
mod colrm;
mod column;
mod comm;
mod compress;
mod constants;
#[cfg(feature = "gh")]
mod core;
mod cut;
mod date;
mod deserialize;
mod diff;
mod digest;
mod document;
mod du;
mod envsubst;
mod expand;
mod expr;
mod file;
mod find;
mod find_printf;
mod fold;
mod generated;
mod glob;
mod grep;
mod head;
#[cfg(test)]
mod host;
mod iconv;
mod integer;
pub mod interp;
mod join;
mod jq;
mod json_validate;
mod lance_query;
mod look;
mod ls;
mod network;
pub mod nfs;
mod nl;
mod number;
mod numfmt;
mod od;
mod paste;
mod patch;
mod pcre;
mod policy;
mod printf;
mod quote;
mod records;
mod reflow;
mod regex;
mod request;
mod rev;
mod rg;
mod rg_format;
mod rg_grapheme;
mod rg_input;
mod rg_matcher;
mod rg_options;
mod sanitize;
mod scan;
mod scan_grammar;
mod sed;
mod select;
mod seq;
pub mod shell;
mod shuf;
mod shuf_options;
mod sort;
mod split;
mod stream;
mod strftime;
mod strings;
mod tac;
mod tail;
mod tar;
mod task;
mod tr;
mod tree;
mod truncate;
mod tsort;
mod uniq;
mod utf8;
pub mod vars;
mod wc;
mod width;
mod word;
mod xxd;
mod zip;

pub use constants::{PIECE, STEPS};
pub(crate) use deserialize::{
    latin1, latin1_list, latin1_opt, parse_config, saturating_u64, saturating_u64_opt,
    saturating_usize, saturating_usize_opt,
};
pub(crate) use quote::{quoted, shell_quoted};
pub use stream::{Stream, StreamError, drain_steps, release_capacity};
pub(crate) use stream::{byte_text, latin1_bytes};

/// Open the stream `kind` from its JSON configuration.
pub fn open(kind: &str, config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    match kind {
        "awk" => awk::open(config),
        "base64" => base64::open(config),
        "bc" => bc::open(config),
        "cmp" => cmp::open(config),
        "column" => column::open(config),
        "colrm" => colrm::open(config),
        "comm" => comm::open(config),
        "compress" => compress::open(config),
        "csplit" => split::csplit::open(config),
        "cut" => cut::open(config),
        "digest" => digest::open(config),
        "expand" => expand::open_expand(config),
        "envsubst" => envsubst::open(config),
        "file" => file::open(config),
        "fmt" => reflow::open(config),
        "fold" => fold::open(config),
        "diff" => diff::open(config),
        "glob" => glob::open(config),
        "glob_tails" => glob::open_tails(config),
        "grep" => grep::open(config),
        "iconv" => iconv::open(config),
        "join" => join::open(config),
        "jq_options" => jq::open_options(config),
        "jq_link" => jq::open_link(config),
        "jq_eval" => jq::open_eval(config),
        "jq" => jq::open_main(config),
        "look" => look::open(config),
        "network" => network::open(config),
        "cat" => cat::open(config),
        "nl" => nl::open(config),
        "numfmt" => numfmt::open(config),
        "od" => od::open(config),
        "paste" => paste::open(config),
        "patch" => patch::open(config),
        "policy" => policy::stream::open(config),
        "policy_compose" => policy::composition::open(config),
        "document" => document::open(config),
        "printf" => printf::open(config),
        "regex" => regex::stream::open(config),
        "rev" => rev::open(config),
        "rg" => rg::open(config),
        "rg_format" => rg_format::open(config),
        "scan" => scan::open(config),
        "quote" => quote::open(config),
        "ls_columns" => ls::open_columns(config),
        "width" => width::open(config),
        "date" => date::open(config),
        "date_lines" => date::open_lines(config),
        "expr" => expr::open(config),
        "find_printf" => find_printf::open(config),
        "strftime" => strftime::open(config),
        "json_validate" => json_validate::open(config),
        "lance_query" => lance_query::open(config),
        "sanitize" => sanitize::open(config),
        "sed" => sed::open(config),
        "select" => select::open(config),
        "seq" => seq::open(config),
        "shuf" => shuf::open(config),
        "sort" => sort::open(config),
        "split" => split::open(config),
        "strings" => strings::open(config),
        "tac" => tac::open(config),
        "tar" => tar::stream::open(config),
        "tr" => tr::open(config),
        "tsort" => tsort::open(config),
        "unexpand" => expand::open_unexpand(config),
        "uniq" => uniq::open(config),
        "unzip" => zip::open_unzip(config),
        "wc" => wc::open(config),
        #[cfg(feature = "gh")]
        "gh" => cli::gh::open(config),
        "office" => cli::office::stream::open(config),
        #[cfg(feature = "pdf")]
        "pdfinfo" => cli::pdf::open_info(config),
        #[cfg(feature = "pdf")]
        "pdftotext" => cli::pdf::open_text(config),
        "xxd" => xxd::open(config),
        "zip" => zip::open_zip(config),
        _ => Err(StreamError::new(format!("unknown stream: {kind}"))),
    }
}

#[cfg(test)]
pub(crate) fn run(kind: &str, config: &str, chunks: &[&[u8]]) -> (Vec<u8>, Option<StreamError>) {
    let mut stream = open(kind, config.as_bytes()).expect("stream opens");
    let mut out = Vec::new();
    for chunk in chunks {
        if let Err(err) = stream.feed(chunk, &mut out) {
            return (out, Some(err));
        }
        drain_all(stream.as_mut(), &mut out);
    }
    let err = stream.finish(&mut out).err();
    drain_all(stream.as_mut(), &mut out);
    (out, err)
}

/// A stream's JSON configuration: `defaults` with `options`' fields laid
/// over them.
#[cfg(test)]
pub(crate) fn config(defaults: &str, options: &str) -> String {
    let mut config: serde_json::Value = serde_json::from_str(defaults).expect("defaults");
    let options: serde_json::Value = serde_json::from_str(options).expect("options");
    for (name, value) in options.as_object().expect("an object") {
        config[name] = value.clone();
    }
    config.to_string()
}

#[cfg(test)]
pub(crate) fn drain_all(stream: &mut dyn Stream, out: &mut Vec<u8>) {
    while stream.busy() {
        while stream.busy() {
            stream.drain(out).expect("drain");
        }
        stream.feed(&[], out).expect("feed");
    }
}
