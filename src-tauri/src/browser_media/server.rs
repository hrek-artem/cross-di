use super::{Bridge, SyncPacket};
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::Arc,
    time::Duration,
};

const MAX_BODY: usize = 3 * 1024 * 1024;

pub(super) fn run(listener: TcpListener, bridge: Arc<Bridge>) {
    for mut stream in listener.incoming().flatten() {
        let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
        let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
        let _ = serve(&mut stream, &bridge);
    }
}

fn extension_origin(origin: &str) -> bool {
    origin
        .strip_prefix("chrome-extension://")
        .is_some_and(|id| id.len() == 32 && id.bytes().all(|b| (b'a'..=b'p').contains(&b)))
}

fn respond(
    stream: &mut TcpStream,
    code: &str,
    origin: Option<&str>,
    body: &str,
) -> std::io::Result<()> {
    let cors = origin
        .filter(|s| extension_origin(s))
        .map(|s| format!("Access-Control-Allow-Origin: {s}\r\nVary: Origin\r\n"))
        .unwrap_or_default();
    write!(
        stream,
        "HTTP/1.1 {code}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\nAccess-Control-Allow-Methods: POST, OPTIONS\r\nAccess-Control-Allow-Headers: authorization, content-type\r\nAccess-Control-Allow-Private-Network: true\r\n{cors}\r\n{body}",
        body.len()
    )
}

fn serve(stream: &mut TcpStream, bridge: &Bridge) -> std::io::Result<()> {
    let mut bytes = Vec::new();
    let mut chunk = [0; 4096];
    let header_end = loop {
        let read = stream.read(&mut chunk)?;
        if read == 0 {
            return Ok(());
        }
        bytes.extend_from_slice(&chunk[..read]);
        if let Some(end) = bytes.windows(4).position(|s| s == b"\r\n\r\n") {
            break end + 4;
        }
        if bytes.len() > 8192 {
            return respond(stream, "431 Request Header Fields Too Large", None, "{}");
        }
    };
    if header_end > 8192 {
        return respond(stream, "431 Request Header Fields Too Large", None, "{}");
    }
    let Ok(headers) = std::str::from_utf8(&bytes[..header_end]) else {
        return respond(stream, "400 Bad Request", None, "{}");
    };
    let mut lines = headers.split("\r\n");
    let request = lines.next().unwrap_or_default().to_owned();
    let fields: Vec<_> = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_owned()))
        .collect();
    let header = |key: &str| {
        fields
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    };
    let origin = header("origin");
    if request == "GET /status HTTP/1.1" {
        if origin.is_some_and(|value| !extension_origin(value))
            || header("host") != Some("127.0.0.1:43191")
        {
            return respond(stream, "403 Forbidden", None, "{}");
        }
        if header("authorization") != Some(format!("Bearer {}", bridge.token).as_str()) {
            return respond(stream, "401 Unauthorized", origin, "{}");
        }
        let inner = bridge.inner.lock().unwrap_or_else(|e| e.into_inner());
        let body = serde_json::json!({ "sessions": inner.sessions.len(), "videoOffers": inner.video.len(), "videoStatus": inner.video_status });
        return respond(stream, "200 OK", origin, &body.to_string());
    }
    if request == "OPTIONS /sync HTTP/1.1" {
        if origin.is_some_and(|value| !extension_origin(value))
            || header("host") != Some("127.0.0.1:43191")
        {
            return respond(stream, "403 Forbidden", None, "{}");
        }
        return respond(stream, "204 No Content", origin, "");
    }
    if request != "POST /sync HTTP/1.1" {
        return respond(stream, "404 Not Found", origin, "{}");
    }
    let Some(length) = header("content-length")
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|n| *n <= MAX_BODY)
    else {
        return respond(stream, "413 Content Too Large", origin, "{}");
    };
    if header("transfer-encoding").is_some() {
        return respond(stream, "400 Bad Request", origin, "{}");
    }
    while bytes.len() - header_end < length {
        let remaining = (length - (bytes.len() - header_end)).min(chunk.len());
        let read = stream.read(&mut chunk[..remaining])?;
        if read == 0 {
            return Ok(());
        }
        bytes.extend_from_slice(&chunk[..read]);
    }
    // Read the bounded body before rejecting credentials so Windows can close
    // the connection cleanly without discarding the HTTP error with a TCP reset.
    if origin.is_some_and(|value| !extension_origin(value))
        || header("host") != Some("127.0.0.1:43191")
    {
        return respond(stream, "403 Forbidden", None, "{}");
    }
    if header("authorization") != Some(format!("Bearer {}", bridge.token).as_str()) {
        return respond(stream, "401 Unauthorized", origin, "{}");
    }
    let result = serde_json::from_slice::<SyncPacket>(&bytes[header_end..header_end + length])
        .ok()
        .and_then(|packet| {
            let client = packet.client_id.clone();
            bridge
                .sync(packet)
                .ok()
                .map(|commands| bridge.video_response(&client, commands))
        });
    match result {
        Some(response) => respond(stream, "200 OK", origin, &response.to_string()),
        None => respond(stream, "400 Bad Request", origin, "{}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_extension_origins_are_allowed() {
        assert!(extension_origin(
            "chrome-extension://abcdefghijklmnopabcdefghijklmnop"
        ));
        assert!(!extension_origin("https://example.com"));
        assert!(!extension_origin(
            "chrome-extension://abcdefghijklmnopabcdefghijklmnop.attacker"
        ));
    }

    #[test]
    fn http_requires_token_and_rejects_web_pages() {
        fn exchange(origin: &str, token: &str) -> String {
            let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
            let address = listener.local_addr().unwrap();
            let token = token.to_owned();
            let origin = origin.to_owned();
            let worker = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                let bridge = Bridge {
                    token: "a".repeat(64),
                    error: None,
                    notify: None,
                    inner: Default::default(),
                };
                serve(&mut stream, &bridge).unwrap();
            });
            let mut client = TcpStream::connect(address).unwrap();
            let body = r#"{"clientId":"test","sessions":[]}"#;
            write!(client, "POST /sync HTTP/1.1\r\nHost: 127.0.0.1:43191\r\nOrigin: {origin}\r\nAuthorization: Bearer {token}\r\nContent-Length: {}\r\n\r\n{body}", body.len()).unwrap();
            let mut result = String::new();
            client.read_to_string(&mut result).unwrap();
            worker.join().unwrap();
            result
        }
        let extension = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
        assert!(exchange(extension, &"a".repeat(64)).starts_with("HTTP/1.1 200"));
        assert!(exchange(extension, "incorrect").starts_with("HTTP/1.1 401"));
        assert!(exchange("https://example.com", &"a".repeat(64)).starts_with("HTTP/1.1 403"));
    }
}
