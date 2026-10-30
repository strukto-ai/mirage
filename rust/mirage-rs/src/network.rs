use std::net::IpAddr;

use serde::Deserialize;

use crate::{Stream, StreamError, parse_config};

// Where clouds serve a machine its credentials: the IPv4 and IPv6
// link-local ranges, and AWS's IPv6 metadata address.
const METADATA: [&str; 3] = ["169.254.0.0/16", "fe80::/10", "fd00:ec2::254"];

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    layers: Vec<LayerConfig>,
    #[serde(default)]
    metadata: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LayerConfig {
    #[serde(default)]
    allow: Option<Vec<String>>,
    #[serde(default)]
    deny: Vec<String>,
}

enum Target {
    Any,
    Range(IpAddr, u8),
    Host(String),
    Suffix(String),
}

struct Entry {
    target: Target,
    port: Option<u16>,
}

struct Layer {
    allow: Option<Vec<Entry>>,
    deny: Vec<Entry>,
}

struct Network {
    layers: Vec<Layer>,
}

/// Whether a workspace may open one connection. A rule is a list of layers,
/// the workspace's own `network` setting and an operator's ceiling among
/// them, and a connection opens only when every layer lets it: a layer with
/// an allow list lets what an entry names, and none lets what its deny list
/// names. The hosts ask once per connection with the host name, the address
/// it resolved to and the port, `host\0address\0port`, any part empty when
/// not known.
pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let config: Config = parse_config(config)?;
    let mut layers = config
        .layers
        .iter()
        .map(|layer| {
            Ok(Layer {
                allow: layer
                    .allow
                    .as_ref()
                    .map(|entries| entries.iter().map(|text| entry(text)).collect())
                    .transpose()?,
                deny: layer
                    .deny
                    .iter()
                    .map(|text| entry(text))
                    .collect::<Result<_, _>>()?,
            })
        })
        .collect::<Result<Vec<_>, StreamError>>()?;
    if config.metadata {
        layers.push(Layer {
            allow: None,
            deny: METADATA
                .iter()
                .map(|text| entry(text))
                .collect::<Result<_, _>>()?,
        });
    }
    Ok(Box::new(Network { layers }))
}

/// One allow or deny entry: `*` for every host, an address (an IPv6 one
/// bracketed when a port follows), a range in CIDR form, a host name, or `*.`
/// and a name for every host under it; any but a range may end in `:port`.
fn entry(text: &str) -> Result<Entry, StreamError> {
    let bad = || {
        StreamError::new(format!(
            "network: {text} is not an address, a range or a host name"
        ))
    };
    if let Ok(target) = target(text) {
        return Ok(Entry { target, port: None });
    }
    let (head, port) = match text.rsplit_once(':') {
        Some((head, port))
            if !port.is_empty() && port.bytes().all(|byte| byte.is_ascii_digit()) =>
        {
            (
                head,
                port.parse::<u16>()
                    .ok()
                    .filter(|port| *port > 0)
                    .ok_or_else(bad)?,
            )
        }
        _ => return Err(bad()),
    };
    let head = head
        .strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'))
        .map_or(Ok(head), |inner| {
            inner.parse::<IpAddr>().map(|_| inner).map_err(|_| bad())
        })?;
    // An IPv6 address names its port only in brackets, as in a URL.
    if !text.starts_with('[') && head.contains(':') {
        return Err(bad());
    }
    let target = target(head).map_err(|_| bad())?;
    if matches!(target, Target::Range(address, bits) if bits < width(address)) {
        return Err(bad());
    }
    Ok(Entry {
        target,
        port: Some(port),
    })
}

fn width(address: IpAddr) -> u8 {
    if address.is_ipv4() { 32 } else { 128 }
}

/// What an entry names, without its port.
fn target(text: &str) -> Result<Target, StreamError> {
    let bad = || {
        StreamError::new(format!(
            "network: {text} is not an address, a range or a host name"
        ))
    };
    if text == "*" {
        return Ok(Target::Any);
    }
    let text = text
        .strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'))
        .filter(|inner| inner.parse::<IpAddr>().is_ok())
        .unwrap_or(text);
    let (head, prefix) = match text.split_once('/') {
        Some((head, prefix)) => (head, Some(prefix)),
        None => (text, None),
    };
    if let Ok(address) = head.parse::<IpAddr>() {
        let width = width(address);
        let bits = match prefix {
            None => width,
            Some(prefix) => prefix
                .parse::<u8>()
                .ok()
                .filter(|bits| *bits <= width)
                .ok_or_else(bad)?,
        };
        return Ok(match address {
            IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
                Some(v4) if bits >= 96 => Target::Range(IpAddr::V4(v4), bits - 96),
                _ => Target::Range(address, bits),
            },
            IpAddr::V4(_) => Target::Range(address, bits),
        });
    }
    if prefix.is_some() {
        return Err(bad());
    }
    let name = text.trim_end_matches('.').to_ascii_lowercase();
    let (wildcard, name) = match name.strip_prefix("*.") {
        Some(rest) => (true, rest.to_string()),
        None => (false, name),
    };
    if name.is_empty() || !name.split('.').all(label) {
        return Err(bad());
    }
    Ok(if wildcard {
        Target::Suffix(name)
    } else {
        Target::Host(name)
    })
}

fn label(label: &str) -> bool {
    !label.is_empty()
        && label.len() <= 63
        && label
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

/// An address as a host reports it: bracketed or not, with a zone or not,
/// and an IPv4 address written as IPv6 (`::ffff:a.b.c.d`) read as itself.
fn address(text: &str) -> Option<IpAddr> {
    let text = text
        .strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'))
        .unwrap_or(text);
    let text = text.split_once('%').map_or(text, |(head, _)| head);
    match text.parse::<IpAddr>().ok()? {
        IpAddr::V6(v6) => Some(v6.to_ipv4_mapped().map_or(IpAddr::V6(v6), IpAddr::V4)),
        v4 => Some(v4),
    }
}

fn within(range: IpAddr, bits: u8, address: IpAddr) -> bool {
    let (range, address, width) = match (range, address) {
        (IpAddr::V4(range), IpAddr::V4(address)) => (
            u128::from(u32::from(range)),
            u128::from(u32::from(address)),
            32,
        ),
        (IpAddr::V6(range), IpAddr::V6(address)) => (u128::from(range), u128::from(address), 128),
        _ => return false,
    };
    bits == 0 || range >> (width - u32::from(bits)) == address >> (width - u32::from(bits))
}

impl Entry {
    /// Whether the entry names a connection. A port it names matches a port
    /// not yet known only when `unknown` says so: a lookup's answer is let
    /// through for the connect to judge, never refused for a port it lacks.
    fn names(&self, host: &str, address: Option<IpAddr>, port: Option<u16>, unknown: bool) -> bool {
        let reached = match &self.target {
            Target::Any => true,
            Target::Range(range, bits) => {
                address.is_some_and(|address| within(*range, *bits, address))
            }
            Target::Host(name) => host == name,
            Target::Suffix(name) => host
                .strip_suffix(name.as_str())
                .is_some_and(|head| head.ends_with('.') && head.len() > 1),
        };
        reached
            && self
                .port
                .is_none_or(|wanted| port.map_or(unknown, |port| port == wanted))
    }
}

impl Layer {
    fn lets(&self, host: &str, address: Option<IpAddr>, port: Option<u16>) -> bool {
        self.allow.as_ref().is_none_or(|allow| {
            allow
                .iter()
                .any(|entry| entry.names(host, address, port, true))
        }) && !self
            .deny
            .iter()
            .any(|entry| entry.names(host, address, port, false))
    }
}

impl Stream for Network {
    fn feed(&mut self, _: &[u8], _: &mut Vec<u8>) -> Result<(), StreamError> {
        Err(StreamError::new("network answers test only"))
    }

    fn finish(&mut self, _: &mut Vec<u8>) -> Result<(), StreamError> {
        Err(StreamError::new("network answers test only"))
    }

    fn test(&mut self, input: &[u8]) -> Result<bool, StreamError> {
        let text = std::str::from_utf8(input)
            .map_err(|_| StreamError::new("network: the subject is not UTF-8"))?;
        let mut parts = text.splitn(3, '\0');
        let host = parts.next().unwrap_or("");
        let given = parts.next().unwrap_or("");
        let port = match parts.next().unwrap_or("") {
            "" => None,
            port => Some(
                port.parse::<u16>()
                    .map_err(|_| StreamError::new(format!("network: {port} is not a port")))?,
            ),
        };
        let host = host.trim_end_matches('.').to_ascii_lowercase();
        let found =
            if given.is_empty() {
                address(&host)
            } else {
                Some(address(given).ok_or_else(|| {
                    StreamError::new(format!("network: {given} is not an address"))
                })?)
            };
        let host = if found.is_some() && address(&host).is_some() {
            String::new()
        } else {
            host
        };
        Ok(self
            .layers
            .iter()
            .all(|layer| layer.lets(&host, found, port)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(config: &str) -> Box<dyn Stream> {
        open(config.as_bytes()).expect("rule opens")
    }

    fn lets(rule: &mut Box<dyn Stream>, host: &str, address: &str) -> bool {
        rule.test(format!("{host}\0{address}").as_bytes())
            .expect("answers")
    }

    fn reaches(rule: &mut Box<dyn Stream>, host: &str, address: &str, port: &str) -> bool {
        rule.test(format!("{host}\0{address}\0{port}").as_bytes())
            .expect("answers")
    }

    #[test]
    fn no_layer_lets_every_connection() {
        let mut open_rule = rule(r#"{"layers": []}"#);
        assert!(lets(&mut open_rule, "example.com", "93.184.216.34"));
        assert!(lets(&mut open_rule, "", "127.0.0.1"));
    }

    #[test]
    fn an_empty_allow_list_is_the_network_off() {
        let mut off = rule(r#"{"layers": [{"allow": []}]}"#);
        assert!(!lets(&mut off, "example.com", "93.184.216.34"));
        assert!(!lets(&mut off, "", "127.0.0.1"));
    }

    #[test]
    fn an_allow_list_names_hosts_suffixes_and_ranges() {
        let mut allow = rule(
            r#"{"layers": [{"allow": ["API.GitHub.com.", "*.slack.com", "10.0.0.0/8", "::1"]}]}"#,
        );
        assert!(lets(&mut allow, "api.github.com", "140.82.112.6"));
        assert!(lets(&mut allow, "API.GITHUB.COM.", ""));
        assert!(!lets(&mut allow, "github.com", "140.82.112.4"));
        assert!(lets(&mut allow, "files.slack.com", "1.2.3.4"));
        assert!(lets(&mut allow, "a.b.slack.com", ""));
        assert!(!lets(&mut allow, "slack.com", ""));
        assert!(!lets(&mut allow, "notslack.com", ""));
        assert!(lets(&mut allow, "", "10.20.30.40"));
        assert!(lets(&mut allow, "db.internal", "10.0.0.5"));
        assert!(!lets(&mut allow, "", "11.0.0.1"));
        assert!(lets(&mut allow, "", "[::1]"));
        assert!(lets(&mut allow, "::1", ""));
    }

    #[test]
    fn an_entry_can_name_a_port_and_every_host() {
        let mut ported = rule(
            r#"{"layers": [{"allow": ["api.github.com:443", "*.example.com", "127.0.0.1:3000", "[::1]:8080"], "deny": ["*:22"]}]}"#,
        );
        assert!(reaches(
            &mut ported,
            "api.github.com",
            "140.82.112.6",
            "443"
        ));
        assert!(!reaches(
            &mut ported,
            "api.github.com",
            "140.82.112.6",
            "80"
        ));
        assert!(reaches(&mut ported, "files.example.com", "", "8443"));
        assert!(!reaches(&mut ported, "files.example.com", "", "22"));
        assert!(reaches(&mut ported, "", "127.0.0.1", "3000"));
        assert!(!reaches(&mut ported, "", "127.0.0.1", "3001"));
        assert!(reaches(&mut ported, "", "::1", "8080"));
        assert!(!reaches(&mut ported, "", "::1", "8081"));
        // A lookup knows no port yet: an allowed name passes for the connect
        // to judge, and a port's denial waits for that connect too.
        assert!(lets(&mut ported, "api.github.com", "140.82.112.6"));
        assert!(lets(&mut ported, "files.example.com", ""));
        let mut all = rule(r#"{"layers": [{"allow": ["*"]}]}"#);
        assert!(reaches(&mut all, "anything.test", "1.2.3.4", "9"));
        let mut none = rule(r#"{"layers": [{"deny": ["*"]}]}"#);
        assert!(!reaches(&mut none, "", "127.0.0.1", "80"));
    }

    #[test]
    fn an_ipv4_address_written_as_ipv6_is_itself() {
        let mut allow = rule(r#"{"layers": [{"allow": ["10.0.0.0/8"]}]}"#);
        assert!(lets(&mut allow, "", "::ffff:10.1.2.3"));
        let mut mapped = rule(r#"{"layers": [{"allow": ["::ffff:10.0.0.0/104"]}]}"#);
        assert!(lets(&mut mapped, "", "10.9.9.9"));
        assert!(!lets(&mut mapped, "", "11.9.9.9"));
    }

    #[test]
    fn every_layer_must_let_a_connection() {
        let mut both =
            rule(r#"{"layers": [{"allow": ["*.example.com"]}, {"deny": ["10.0.0.0/8"]}]}"#);
        assert!(lets(&mut both, "api.example.com", "93.184.216.34"));
        assert!(!lets(&mut both, "api.example.com", "10.0.0.5"));
        assert!(!lets(&mut both, "api.other.com", "93.184.216.34"));
    }

    #[test]
    fn the_metadata_block_refuses_link_local_addresses() {
        let mut guarded = rule(r#"{"layers": [], "metadata": true}"#);
        assert!(!lets(&mut guarded, "", "169.254.169.254"));
        assert!(!lets(&mut guarded, "evil.example.com", "169.254.170.2"));
        assert!(!lets(&mut guarded, "", "::ffff:169.254.169.254"));
        assert!(!lets(&mut guarded, "", "fd00:ec2::254"));
        assert!(!lets(&mut guarded, "", "fe80::1%eth0"));
        assert!(lets(&mut guarded, "example.com", "93.184.216.34"));
    }

    #[test]
    fn a_bad_entry_or_address_is_refused() {
        for config in [
            r#"{"layers": [{"allow": ["10.0.0.0/33"]}]}"#,
            r#"{"layers": [{"allow": ["exa mple.com"]}]}"#,
            r#"{"layers": [{"allow": ["host.com/8"]}]}"#,
            r#"{"layers": [{"allow": ["*."]}]}"#,
            r#"{"layers": [{"deny": [""]}]}"#,
            r#"{"layers": [{"other": []}]}"#,
            r#"{"layers": [{"allow": ["example.com:0"]}]}"#,
            r#"{"layers": [{"allow": ["example.com:70000"]}]}"#,
            r#"{"layers": [{"allow": ["10.0.0.0/8:443"]}]}"#,
            r#"{"layers": [{"allow": ["example.com:"]}]}"#,
        ] {
            assert!(open(config.as_bytes()).is_err(), "{config}");
        }
        let mut allow = rule(r#"{"layers": [{"allow": ["10.0.0.0/8"]}]}"#);
        assert!(allow.test(b"example.com\0not an address").is_err());
        assert!(allow.test(b"example.com\0\0not a port").is_err());
    }
}
