use std::collections::{HashMap, VecDeque};
use std::convert::Infallible;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use futures_util::TryStreamExt;
use http_body_util::{combinators::UnsyncBoxBody, BodyExt, Empty, StreamBody};
use hyper::body::{Frame, Incoming};
use hyper::header::{self, HeaderName, HeaderValue};
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use tauri::State;

const MAX_ENTRIES: usize = 64;

const FORWARD_REQUEST: [HeaderName; 4] = [
    header::RANGE,
    header::IF_RANGE,
    header::IF_NONE_MATCH,
    header::IF_MODIFIED_SINCE,
];

const FORWARD_RESPONSE: [HeaderName; 7] = [
    header::CONTENT_TYPE,
    header::CONTENT_LENGTH,
    header::CONTENT_RANGE,
    header::ACCEPT_RANGES,
    header::ETAG,
    header::LAST_MODIFIED,
    header::CACHE_CONTROL,
];

const NAME_KEEP: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~');

type BoxError = Box<dyn std::error::Error + Send + Sync>;
type Body = UnsyncBoxBody<Bytes, BoxError>;

#[derive(Clone)]
struct Entry {
    url: reqwest::Url,
    authorization: Option<String>,
    name: String,
}

#[derive(Default)]
struct Registry {
    entries: HashMap<String, Entry>,
    order: VecDeque<String>,
}

impl Registry {
    fn insert(&mut self, token: String, entry: Entry) {
        while self.order.len() >= MAX_ENTRIES {
            if let Some(oldest) = self.order.pop_front() {
                self.entries.remove(&oldest);
            }
        }
        self.order.push_back(token.clone());
        self.entries.insert(token, entry);
    }

    fn remove(&mut self, token: &str) {
        if self.entries.remove(token).is_some() {
            self.order.retain(|t| t != token);
        }
    }
}

struct Inner {
    registry: Mutex<Registry>,
    client: reqwest::Client,
}

pub struct MediaServer {
    inner: Arc<Inner>,
    port: Mutex<Option<u16>>,
}

impl Default for MediaServer {
    fn default() -> Self {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .build()
            .unwrap_or_default();
        Self {
            inner: Arc::new(Inner {
                registry: Mutex::new(Registry::default()),
                client,
            }),
            port: Mutex::new(None),
        }
    }
}

impl MediaServer {
    pub fn register(
        &self,
        url: &str,
        authorization: Option<String>,
        name: &str,
    ) -> Result<String, String> {
        let url = reqwest::Url::parse(url).map_err(|e| format!("Invalid preview URL: {}", e))?;
        if !matches!(url.scheme(), "http" | "https") {
            return Err("Only http and https URLs can be previewed".to_string());
        }
        let port = self.listen()?;
        let token = crate::rc_session::random_secret();
        self.inner.registry.lock().unwrap().insert(
            token.clone(),
            Entry {
                url,
                authorization,
                name: name.to_string(),
            },
        );
        Ok(format!(
            "http://127.0.0.1:{}/m/{}/{}",
            port,
            token,
            utf8_percent_encode(name, NAME_KEEP)
        ))
    }

    pub fn release(&self, url: &str) {
        let path = url.split_once("://").map_or(url, |(_, rest)| rest);
        let path = path.find('/').map_or("", |i| &path[i..]);
        if let Some(token) = token_of(path) {
            self.inner.registry.lock().unwrap().remove(token);
        }
    }

    fn listen(&self) -> Result<u16, String> {
        let mut port = self.port.lock().unwrap();
        if let Some(port) = *port {
            return Ok(port);
        }
        let listener = std::net::TcpListener::bind("127.0.0.1:0")
            .map_err(|e| format!("Failed to start the preview server: {}", e))?;
        listener
            .set_nonblocking(true)
            .map_err(|e| format!("Failed to start the preview server: {}", e))?;
        let bound = listener
            .local_addr()
            .map_err(|e| format!("Failed to start the preview server: {}", e))?
            .port();
        tauri::async_runtime::spawn(serve(listener, self.inner.clone(), bound));
        *port = Some(bound);
        Ok(bound)
    }
}

async fn serve(listener: std::net::TcpListener, inner: Arc<Inner>, port: u16) {
    let listener = match tokio::net::TcpListener::from_std(listener) {
        Ok(listener) => listener,
        Err(e) => {
            log::error!("the preview server could not start: {}", e);
            return;
        }
    };
    loop {
        let stream = match listener.accept().await {
            Ok((stream, _)) => stream,
            Err(e) => {
                log::warn!("the preview server could not accept a connection: {}", e);
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            }
        };
        let inner = inner.clone();
        tauri::async_runtime::spawn(async move {
            let service = hyper::service::service_fn(move |req| {
                let inner = inner.clone();
                async move { Ok::<_, Infallible>(handle(req, &inner, port).await) }
            });
            let _ = hyper::server::conn::http1::Builder::new()
                .serve_connection(TokioIo::new(stream), service)
                .await;
        });
    }
}

async fn handle(req: Request<Incoming>, inner: &Inner, port: u16) -> Response<Body> {
    if req.method() != Method::GET && req.method() != Method::HEAD {
        return status(StatusCode::METHOD_NOT_ALLOWED);
    }
    let host = req.headers().get(header::HOST).and_then(|h| h.to_str().ok());
    if !host.is_some_and(|h| allowed_host(h, port)) {
        return status(StatusCode::FORBIDDEN);
    }
    let entry = token_of(req.uri().path())
        .and_then(|token| inner.registry.lock().unwrap().entries.get(token).cloned());
    let Some(entry) = entry else {
        return status(StatusCode::NOT_FOUND);
    };
    let download = req
        .uri()
        .query()
        .is_some_and(|q| q.split('&').any(|p| p == "download=1"));

    let mut upstream = inner.client.request(req.method().clone(), entry.url.clone());
    for name in FORWARD_REQUEST.iter() {
        if let Some(value) = req.headers().get(name) {
            upstream = upstream.header(name, value);
        }
    }
    if let Some(authorization) = &entry.authorization {
        upstream = upstream.header(header::AUTHORIZATION, authorization);
    }
    let res = match upstream.send().await {
        Ok(res) => res,
        Err(e) => {
            log::warn!("a preview could not be read from rclone: {}", e.without_url());
            return status(StatusCode::BAD_GATEWAY);
        }
    };

    let mut out = Response::builder().status(res.status());
    for name in FORWARD_RESPONSE.iter() {
        if let Some(value) = res.headers().get(name) {
            out = out.header(name, value);
        }
    }
    out = out
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::CONTENT_SECURITY_POLICY, "sandbox");
    if download {
        out = out.header(header::CONTENT_DISPOSITION, attachment(&entry.name));
    }
    let body = if req.method() == Method::HEAD {
        empty()
    } else {
        StreamBody::new(
            res.bytes_stream()
                .map_ok(Frame::data)
                .map_err(|e| Box::new(e) as BoxError),
        )
        .boxed_unsync()
    };
    out.body(body)
        .unwrap_or_else(|_| status(StatusCode::BAD_GATEWAY))
}

fn token_of(path: &str) -> Option<&str> {
    let token = path.strip_prefix("/m/")?.split('/').next()?;
    (!token.is_empty()).then_some(token)
}

fn allowed_host(host: &str, port: u16) -> bool {
    host == format!("127.0.0.1:{}", port) || host == format!("localhost:{}", port)
}

fn attachment(name: &str) -> HeaderValue {
    let ascii: String = name
        .chars()
        .map(|c| match c {
            ' '..='~' if c != '"' && c != '\\' => c,
            _ => '_',
        })
        .collect();
    let value = format!(
        "attachment; filename=\"{}\"; filename*=UTF-8''{}",
        ascii,
        utf8_percent_encode(name, NAME_KEEP)
    );
    HeaderValue::from_str(&value).unwrap_or_else(|_| HeaderValue::from_static("attachment"))
}

fn empty() -> Body {
    Empty::<Bytes>::new()
        .map_err(|never| match never {})
        .boxed_unsync()
}

fn status(code: StatusCode) -> Response<Body> {
    let mut res = Response::new(empty());
    *res.status_mut() = code;
    res
}

#[tauri::command]
pub fn media_register(
    server: State<'_, MediaServer>,
    url: String,
    authorization: Option<String>,
    name: String,
) -> Result<String, String> {
    server.register(&url, authorization, &name)
}

#[tauri::command]
pub fn media_release(server: State<'_, MediaServer>, url: String) {
    server.release(&url)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;

    fn entry(name: &str) -> Entry {
        Entry {
            url: reqwest::Url::parse("http://localhost:1/x").unwrap(),
            authorization: None,
            name: name.to_string(),
        }
    }

    #[test]
    fn registry_drops_the_oldest() {
        let mut registry = Registry::default();
        for i in 0..MAX_ENTRIES + 2 {
            registry.insert(format!("t{}", i), entry("x"));
        }
        assert_eq!(registry.entries.len(), MAX_ENTRIES);
        assert!(!registry.entries.contains_key("t0"));
        assert!(!registry.entries.contains_key("t1"));
        assert!(registry.entries.contains_key("t2"));
        registry.remove("t2");
        assert!(!registry.entries.contains_key("t2"));
        assert_eq!(registry.order.len(), MAX_ENTRIES - 1);
    }

    #[test]
    fn tokens_and_hosts() {
        assert_eq!(token_of("/m/abc/file.png"), Some("abc"));
        assert_eq!(token_of("/m/abc"), Some("abc"));
        assert_eq!(token_of("/m//file.png"), None);
        assert_eq!(token_of("/x/abc/file.png"), None);
        assert!(allowed_host("127.0.0.1:4000", 4000));
        assert!(allowed_host("localhost:4000", 4000));
        assert!(!allowed_host("example.com:4000", 4000));
        assert!(!allowed_host("127.0.0.1:4001", 4000));
    }

    #[test]
    fn attachment_names() {
        assert_eq!(
            attachment("a \"b\".mp4").to_str().unwrap(),
            "attachment; filename=\"a _b_.mp4\"; filename*=UTF-8''a%20%22b%22.mp4"
        );
        assert_eq!(
            attachment("été.png").to_str().unwrap(),
            "attachment; filename=\"_t_.png\"; filename*=UTF-8''%C3%A9t%C3%A9.png"
        );
    }

    #[test]
    fn rejects_other_schemes() {
        let server = MediaServer::default();
        assert!(server.register("file:///etc/passwd", None, "x").is_err());
        assert!(server.register("not a url", None, "x").is_err());
    }

    fn fake_rclone() -> (String, mpsc::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = [0u8; 4096];
            let n = stream.read(&mut buf).unwrap();
            tx.send(String::from_utf8_lossy(&buf[..n]).to_lowercase())
                .unwrap();
            let body = "ell";
            write!(
                stream,
                "HTTP/1.1 206 Partial Content\r\nContent-Type: video/mp4\r\nContent-Length: {}\r\nContent-Range: bytes 1-3/5\r\nAccept-Ranges: bytes\r\nX-Other: no\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .unwrap();
        });
        (format!("http://{}/[:local:/]/tmp/clip.mp4", addr), rx)
    }

    #[test]
    fn proxies_a_range_with_the_password() {
        tauri::async_runtime::block_on(async {
            let server = MediaServer::default();
            let (upstream, seen) = fake_rclone();
            let url = server
                .register(&upstream, Some("Basic dTpw".to_string()), "clip one.mp4")
                .unwrap();
            assert!(url.starts_with("http://127.0.0.1:"));
            assert!(url.ends_with("/clip%20one.mp4"));

            let client = reqwest::Client::new();
            let res = client
                .get(format!("{}?download=1", url))
                .header("Range", "bytes=1-3")
                .send()
                .await
                .unwrap();
            assert_eq!(res.status(), 206);
            let h = res.headers();
            assert_eq!(h["content-type"], "video/mp4");
            assert_eq!(h["content-range"], "bytes 1-3/5");
            assert_eq!(h["accept-ranges"], "bytes");
            assert_eq!(h["content-security-policy"], "sandbox");
            assert!(h["content-disposition"]
                .to_str()
                .unwrap()
                .starts_with("attachment; filename=\"clip one.mp4\""));
            assert!(h.get("x-other").is_none());
            assert_eq!(res.text().await.unwrap(), "ell");

            let request = seen.recv().unwrap();
            assert!(request.starts_with("get /[:local:/]/tmp/clip.mp4 http/1.1"));
            assert!(request.contains("\r\nrange: bytes=1-3\r\n"));
            assert!(request.contains("\r\nauthorization: basic dtpw\r\n"));
        });
    }

    #[test]
    fn refuses_unknown_tokens_other_hosts_and_methods() {
        tauri::async_runtime::block_on(async {
            let server = MediaServer::default();
            let url = server.register("http://127.0.0.1:1/x", None, "x").unwrap();
            let port = server.listen().unwrap();
            let client = reqwest::Client::new();

            let wrong_token = format!("http://127.0.0.1:{}/m/nope/x", port);
            assert_eq!(client.get(&wrong_token).send().await.unwrap().status(), 404);

            let other_host = client
                .get(&url)
                .header("Host", format!("example.com:{}", port))
                .send()
                .await
                .unwrap();
            assert_eq!(other_host.status(), 403);

            assert_eq!(client.post(&url).send().await.unwrap().status(), 405);

            assert_eq!(client.get(&url).send().await.unwrap().status(), 502);

            server.release(&url);
            assert_eq!(client.get(&url).send().await.unwrap().status(), 404);
        });
    }
}
