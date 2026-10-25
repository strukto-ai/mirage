use serde_json::json;

use crate::host::Host;
use crate::open;

use super::WINDOW;

fn od(options: serde_json::Value, operands: &[&str]) -> Box<dyn crate::Stream> {
    let config = json!({"options": options, "operands": operands});
    open("od", config.to_string().as_bytes()).expect("opens")
}

#[test]
fn operands_read_as_one_input_across_chunks() {
    let mut host = Host::with(
        &[
            ("a", "hello wo"),
            ("b", &format!("rld\n{}", "A".repeat(32))),
        ],
        "",
    );
    host.directories.push("d".into());
    let mut stream = od(json!([["c", true], ["j", "2"]]), &["nope", "a", "d", "b"]);
    assert_eq!(host.drive(stream.as_mut()), 1);
    assert_eq!(
        String::from_utf8_lossy(&host.out),
        "0000002   l   l   o       w   o   r   l   d  \\n   A   A   A   A   A   A\n\
         0000022   A   A   A   A   A   A   A   A   A   A   A   A   A   A   A   A\n\
         0000042   A   A   A   A   A   A   A   A   A   A\n0000054\n"
    );
    assert_eq!(
        String::from_utf8_lossy(&host.err),
        "od: nope: No such file or directory\nod: d: Is a directory\n"
    );
}

#[test]
fn a_chunk_is_dumped_a_window_at_a_time() {
    let mut stream = od(json!([["c", true], ["output_duplicates", true]]), &[]);
    let mut data = Vec::new();
    stream.request(&mut data).expect("reads stdin");
    let chunk = vec![b'x'; 4 * WINDOW];
    let mut out = Vec::new();
    stream.respond(b"{}", &chunk, &mut out).expect("answers");
    let mut drains = 0;
    while stream.busy() {
        out.clear();
        stream.drain(&mut out).expect("drains");
        assert_eq!(out.len(), WINDOW / 16 * 72);
        drains += 1;
    }
    assert_eq!(drains, 4);
}

#[test]
fn a_width_too_wide_to_write_whole_is_refused() {
    let mut host = Host::with(&[("a", "a")], "");
    let mut stream = od(json!([["w", "100000000"], ["format", "x1z"]]), &["a"]);
    assert_eq!(host.drive(stream.as_mut()), 1);
    assert_eq!(host.out, b"");
    assert_eq!(host.err, b"od: -w argument '100000000' too large\n");
}

#[test]
fn a_run_past_the_spill_is_sent_by_the_host_or_dropped() {
    use super::SPILL;
    let long = "x".repeat(2 * SPILL + 5);
    let stdin = format!("{long}\0{}\x01ab\0", "y".repeat(SPILL + 1));
    let mut host = Host::with(&[], &stdin);
    let mut stream = od(json!([["address_radix", "n"], ["S", "2"]]), &[]);
    assert_eq!(host.drive(stream.as_mut()), 0);
    assert_eq!(String::from_utf8_lossy(&host.out), format!("{long}\nab\n"));
}
