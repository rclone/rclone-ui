//! The Download page takes addresses that are web pages (a TikTok video, a SoundCloud track),
//! and `copyurl` needs the media behind them. A third-party service finds that address. The
//! server asks it, because a browser cannot (CORS), and then names the file.

use std::time::Duration;

use reqwest::header::{CONTENT_DISPOSITION, CONTENT_TYPE, RANGE, USER_AGENT};
use reqwest::Url;
use serde::Serialize;
use serde_json::Value;

use crate::datadir::DataDir;
use crate::scheduler::storeread;

/// Free and keyless. Its endpoints and their answers: `<SERVICE>/docs/api-reference`.
const SERVICE: &str = "https://backend1.tioo.eu.org";
/// We go by the name of the service's own client.
const AGENT: &str = "btch/6.4.0";
const TITLE_LENGTH: usize = 42;

/// A host, or any subdomain of it, and the service's endpoint for it.
const PLATFORMS: &[(&str, &str)] = &[
    ("instagram.com", "igdl"),
    ("tiktok.com", "ttdl"),
    ("facebook.com", "fbdown"),
    ("twitter.com", "twitter"),
    ("x.com", "twitter"),
    ("youtube.com", "youtube"),
    ("youtu.be", "youtube"),
    ("mediafire.com", "mediafire"),
    ("capcut.com", "capcut"),
    ("drive.google.com", "gdrive"),
    ("pin.it", "pinterest"),
    ("pinterest.com", "pinterest"),
    ("douyin.com", "douyin"),
    ("xhslink.com", "rednote"),
    ("xiaohongshu.com", "rednote"),
    ("threads.net", "threads"),
    ("threads.com", "threads"),
    ("kuaishou.com", "kuaishou"),
    ("snackvideo.com", "snackvideo"),
    ("icocofun.com", "cocofun"),
    ("spotify.com", "spotify"),
    ("soundcloud.com", "soundcloud"),
];

const KNOWN_EXTENSIONS: &[&str] = &[
    "mp4", "m4v", "webm", "mov", "avi", "wmv", "flv", "mkv", "mp3", "m4a", "aac", "ogg", "wav",
    "jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "heic", "heif", "apk", "zip", "rar", "7z",
    "pdf", "doc", "docx", "ppt", "pptx", "xls", "xlsx",
];

/// Only the types whose extension is not their subtype.
const MIME_EXTENSIONS: &[(&str, &str)] = &[
    ("video/quicktime", "mov"),
    ("video/x-msvideo", "avi"),
    ("video/x-ms-wmv", "wmv"),
    ("video/x-flv", "flv"),
    ("video/x-matroska", "mkv"),
    ("audio/mpeg", "mp3"),
    ("audio/mp4", "m4a"),
    ("image/jpeg", "jpg"),
    ("image/svg+xml", "svg"),
    ("application/x-7z-compressed", "7z"),
    ("application/x-rar-compressed", "rar"),
    ("application/vnd.android.package-archive", "apk"),
];

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Video,
    Audio,
    Image,
    File,
}

#[derive(Debug, PartialEq, Serialize)]
pub struct ResolvedLink {
    pub url: String,
    pub filename: String,
    #[serde(rename = "type")]
    pub kind: Kind,
}

/// `None` for an address of no known platform, and for one the service finds nothing behind:
/// the address is then downloaded as it is.
pub async fn resolve_link(dirs: &DataDir, url: String) -> Result<Option<ResolvedLink>, String> {
    let Some(endpoint) = endpoint_for(&url) else {
        return Ok(None);
    };
    resolve_with(&client(dirs)?, SERVICE, endpoint, &url).await
}

/// Through the proxy of Settings › Rclone, the road the download itself takes.
fn client(dirs: &DataDir) -> Result<reqwest::Client, String> {
    let proxy = storeread::read_host(dirs).ok().and_then(|h| h.proxy);
    crate::http::proxied(proxy.as_ref(), Duration::from_secs(20))
}

fn endpoint_for(url: &str) -> Option<&'static str> {
    let url = Url::parse(url).ok()?;
    let host = url.host_str()?.to_lowercase();
    PLATFORMS
        .iter()
        .find(|(platform, _)| host == *platform || host.ends_with(&format!(".{}", platform)))
        .map(|(_, endpoint)| *endpoint)
}

async fn resolve_with(
    client: &reqwest::Client,
    service: &str,
    endpoint: &str,
    url: &str,
) -> Result<Option<ResolvedLink>, String> {
    let request = Url::parse_with_params(
        &format!("{}/api/downloader/{}", service, endpoint),
        [("url", url)],
    )
    .map_err(|e| e.to_string())?;
    let response = client
        .get(request)
        .header(USER_AGENT, AGENT)
        .send()
        .await
        .map_err(|e| format!("the link service did not answer: {}", e))?;
    if !response.status().is_success() {
        return Err(format!("the link service answered {}", response.status()));
    }
    let data: Value = response
        .json()
        .await
        .map_err(|e| format!("the link service answered something unreadable: {}", e))?;
    let Some(found) = find(endpoint, &data) else {
        return Ok(None);
    };
    // What comes back is handed to rclone and to the page's player: a web address or nothing.
    let media = Url::parse(&found.url)
        .ok()
        .filter(|u| matches!(u.scheme(), "http" | "https"))
        .ok_or("the link service answered with something that is not a web address")?;

    // The title's own extension first: nothing is asked of the media host when it has one.
    let (stem, own) = split_title(&found.title, found.kind);
    let said = found
        .extension
        .map(|e| e.trim_start_matches('.').to_lowercase());
    let mut extension = own
        .or(said.filter(|e| !e.is_empty()))
        .or_else(|| extension_from_url(&media));
    if extension.is_none() {
        extension = extension_from_headers(client, &found.url).await;
    }
    let extension = extension.or_else(|| match found.kind {
        Kind::Video => Some("mp4".to_string()),
        Kind::Audio => Some("mp3".to_string()),
        Kind::Image => Some("jpg".to_string()),
        Kind::File => None,
    });
    Ok(Some(ResolvedLink {
        filename: match extension {
            Some(extension) => format!("{}.{}", stem, extension),
            None => stem,
        },
        url: found.url,
        kind: found.kind,
    }))
}

struct Found {
    title: String,
    url: String,
    kind: Kind,
    extension: Option<String>,
}

fn text(value: &Value) -> Option<String> {
    value.as_str().filter(|s| !s.is_empty()).map(str::to_string)
}

/// The one address worth downloading in each endpoint's answer, best quality first.
fn find(endpoint: &str, d: &Value) -> Option<Found> {
    let titled =
        |value: &Value, fallback: &str| text(value).unwrap_or_else(|| fallback.to_string());
    let found = |title: String, url: String, kind: Kind| Found {
        title,
        url,
        kind,
        extension: None,
    };
    Some(match endpoint {
        "igdl" => {
            let url = d.as_array()?.iter().find_map(|item| text(&item["url"]))?;
            found(
                "Instagram Video".to_string(),
                url.replace("&dl=1", ""),
                Kind::Video,
            )
        }
        "ttdl" => found(
            titled(&d["title"], "TikTok Video"),
            text(&d["video"][0])?,
            Kind::Video,
        ),
        "youtube" => found(
            titled(&d["title"], "YouTube Video"),
            text(&d["mp4"])?,
            Kind::Video,
        ),
        "fbdown" => {
            let url = text(&d["HD"]).or_else(|| text(&d["Normal_video"]))?;
            found("Facebook Video".to_string(), url, Kind::Video)
        }
        "twitter" => {
            let urls = d["url"].as_array()?;
            let url = urls
                .iter()
                .find_map(|u| text(&u["hd"]))
                .or_else(|| urls.iter().find_map(|u| text(&u["sd"])))?;
            found(titled(&d["title"], "Twitter Video"), url, Kind::Video)
        }
        "spotify" => {
            let format = &d["res_data"]["formats"][0];
            Found {
                title: titled(&d["res_data"]["title"], "Spotify Audio"),
                url: text(&format["url"])?,
                kind: Kind::Audio,
                extension: text(&format["ext"]),
            }
        }
        "soundcloud" => {
            let url = text(&d["downloadMp3"]).or_else(|| text(&d["audio"]))?;
            found(titled(&d["title"], "SoundCloud Audio"), url, Kind::Audio)
        }
        "pinterest" => match text(&d["result"]["video_url"]) {
            Some(url) => found("Pinterest Video".to_string(), url, Kind::Video),
            None => found(
                "Pinterest Image".to_string(),
                text(&d["result"]["image"])?,
                Kind::Image,
            ),
        },
        "douyin" => found(
            titled(&d["data"]["title"], "Douyin Video"),
            text(&d["data"]["links"][0]["url"])?,
            Kind::Video,
        ),
        "snackvideo" => found(
            titled(&d["title"], "Snackvideo Video"),
            text(&d["videoUrl"])?,
            Kind::Video,
        ),
        "cocofun" => {
            let url = text(&d["no_watermark"]).or_else(|| text(&d["watermark"]))?;
            found(titled(&d["topic"], "Cocofun Video"), url, Kind::Video)
        }
        "capcut" => found(
            titled(&d["title"], "Capcut Video"),
            text(&d["originalVideoUrl"])?,
            Kind::Video,
        ),
        "gdrive" => found(
            titled(&d["data"]["filename"], "Google Drive File"),
            text(&d["data"]["downloadUrl"])?,
            Kind::File,
        ),
        "mediafire" => Found {
            title: titled(&d["filename"], "MediaFire File"),
            url: text(&d["url"])?,
            kind: Kind::File,
            extension: text(&d["ext"]),
        },
        "rednote" => {
            let note = &d["result"];
            let title = titled(&note["title"], "Rednote");
            match text(&note["downloads"][0]["url"]) {
                Some(url) => found(title, url, Kind::Video),
                None => found(title, text(&note["images"][0])?, Kind::Image),
            }
        }
        "threads" => match text(&d["video"]) {
            Some(url) => found("Threads Video".to_string(), url, Kind::Video),
            None => found("Threads Image".to_string(), text(&d["image"])?, Kind::Image),
        },
        "kuaishou" => found(
            titled(&d["title"], "Kuaishou Video"),
            text(&d["videoUrl"])?,
            Kind::Video,
        ),
        _ => return None,
    })
}

fn is_known(extension: &str) -> bool {
    KNOWN_EXTENSIONS.contains(&extension)
}

/// `clip.MP4` → `mp4`, when that is an extension we know.
fn known_suffix(name: &str) -> Option<String> {
    let (_, suffix) = name.rsplit_once('.')?;
    Some(suffix.to_lowercase()).filter(|s| is_known(s))
}

/// Media hosts say what a file is in its address more often than in its path.
fn extension_from_url(url: &Url) -> Option<String> {
    let param = |keys: &[&str]| {
        url.query_pairs()
            .find(|(key, _)| keys.contains(&key.as_ref()))
            .map(|(_, value)| value.to_lowercase())
    };
    param(&["mime", "mime_type", "type", "content_type"])
        .and_then(|mime| extension_from_mime(&mime))
        .or_else(|| known_suffix(url.path()))
        .or_else(|| param(&["ext", "format", "container", "filetype"]).filter(|e| is_known(e)))
        .or_else(|| {
            url.query_pairs()
                .find_map(|(_, value)| known_suffix(&value))
        })
}

/// `video/mp4; codecs=…` and the `video_mp4` some hosts put in a query.
fn extension_from_mime(mime: &str) -> Option<String> {
    let mime = mime
        .split(';')
        .next()?
        .trim()
        .to_lowercase()
        .replace('_', "/");
    if let Some((_, extension)) = MIME_EXTENSIONS.iter().find(|(known, _)| *known == mime) {
        return Some(extension.to_string());
    }
    let (_, subtype) = mime.split_once('/')?;
    Some(subtype.to_string()).filter(|s| is_known(s))
}

/// `attachment; filename="clip.mp4"`, or the `filename*=UTF-8''clip.mp4` form.
fn extension_from_disposition(disposition: &str) -> Option<String> {
    disposition
        .split(';')
        .filter_map(|part| part.trim().split_once('='))
        .filter(|(key, _)| key.trim().to_lowercase().starts_with("filename"))
        .find_map(|(_, value)| known_suffix(value.trim().trim_matches('"')))
}

/// A HEAD, then one byte of a GET for the servers that refuse a HEAD.
async fn extension_from_headers(client: &reqwest::Client, url: &str) -> Option<String> {
    for request in [client.head(url), client.get(url).header(RANGE, "bytes=0-0")] {
        let Ok(response) = request.send().await else {
            continue;
        };
        if !response.status().is_success() {
            continue;
        }
        let header = |name| response.headers().get(name).and_then(|v| v.to_str().ok());
        let extension = header(CONTENT_DISPOSITION)
            .and_then(extension_from_disposition)
            .or_else(|| header(CONTENT_TYPE).and_then(extension_from_mime));
        if extension.is_some() {
            return extension;
        }
    }
    None
}

/// A title as a file's stem, cut to length, and the extension it came with when it is a file
/// name already (Google Drive, MediaFire).
fn split_title(title: &str, kind: Kind) -> (String, Option<String>) {
    let clean: String = title
        .chars()
        .filter(|c| !c.is_control() && !"<>:\"/\\|?*".contains(*c))
        .collect();
    let clean = clean.split_whitespace().collect::<Vec<_>>().join(" ");
    let own = clean.rsplit_once('.').filter(|(stem, suffix)| {
        let plausible =
            (1..=8).contains(&suffix.len()) && suffix.chars().all(char::is_alphanumeric);
        !stem.is_empty() && plausible && (kind == Kind::File || is_known(&suffix.to_lowercase()))
    });
    let (stem, own) = match own {
        Some((stem, suffix)) => (stem, Some(suffix.to_string())),
        None => (clean.as_str(), None),
    };
    let stem: String = stem.trim().chars().take(TITLE_LENGTH).collect();
    (stem.trim().to_string(), own)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_platform_is_its_host_not_a_mention_of_it() {
        assert_eq!(
            endpoint_for("https://www.youtube.com/watch?v=1"),
            Some("youtube")
        );
        assert_eq!(endpoint_for("https://youtu.be/1"), Some("youtube"));
        assert_eq!(endpoint_for("https://vm.tiktok.com/abc"), Some("ttdl"));
        assert_eq!(endpoint_for("https://X.com/a/status/1"), Some("twitter"));
        assert_eq!(endpoint_for("https://example.com/?from=youtube.com"), None);
        assert_eq!(endpoint_for("https://notx.com/a"), None);
        assert_eq!(endpoint_for("https://docs.google.com/document/d/1"), None);
        assert_eq!(endpoint_for("not a url"), None);
    }

    #[test]
    fn each_answer_gives_its_best_address() {
        let pick = |endpoint: &str, data: Value| find(endpoint, &data).map(|f| (f.title, f.url));
        let some = |title: &str, url: &str| Some((title.to_string(), url.to_string()));
        assert_eq!(
            pick(
                "igdl",
                json!([{ "thumbnail": "t" }, { "url": "https://i/v.mp4?x=1&dl=1" }])
            ),
            some("Instagram Video", "https://i/v.mp4?x=1")
        );
        assert_eq!(
            pick(
                "twitter",
                json!({ "title": "T", "url": [{ "sd": "sd" }, { "hd": "hd" }] })
            ),
            some("T", "hd")
        );
        assert_eq!(
            pick("twitter", json!({ "url": [{ "sd": "sd" }] })),
            some("Twitter Video", "sd")
        );
        assert_eq!(
            pick(
                "soundcloud",
                json!({ "title": "S", "audio": "a", "downloadMp3": "d" })
            ),
            some("S", "d")
        );
        assert_eq!(
            pick("fbdown", json!({ "Normal_video": "n", "HD": "h" })),
            some("Facebook Video", "h")
        );
        assert_eq!(
            pick("cocofun", json!({ "watermark": "w" })),
            some("Cocofun Video", "w")
        );
        assert_eq!(
            pick("pinterest", json!({ "result": { "image": "i" } })),
            some("Pinterest Image", "i")
        );
        assert_eq!(
            pick(
                "rednote",
                json!({ "result": { "title": "R", "images": ["i"], "downloads": [] } })
            ),
            some("R", "i")
        );
        assert_eq!(
            pick("threads", json!({ "type": "video", "video": "v" })),
            some("Threads Video", "v")
        );
        assert_eq!(
            pick("kuaishou", json!({ "videoUrl": "k" })),
            some("Kuaishou Video", "k")
        );
        // What the service says today for a YouTube address: a status and nothing else.
        assert_eq!(pick("youtube", json!({ "status": true })), None);
        assert_eq!(
            pick("gdrive", json!({ "success": true, "message": "404" })),
            None
        );
    }

    #[test]
    fn an_address_says_what_it_holds() {
        let ext = |url: &str| extension_from_url(&Url::parse(url).unwrap());
        assert_eq!(
            ext("https://cdn.example/a/clip.MP4?token=1").as_deref(),
            Some("mp4")
        );
        assert_eq!(
            ext("https://v.example/videoplayback?mime=video%2Fmp4").as_deref(),
            Some("mp4")
        );
        assert_eq!(
            ext("https://v.example/get?mime_type=video_mp4").as_deref(),
            Some("mp4")
        );
        assert_eq!(
            ext("https://v.example/get.php?filename=song.mp3").as_deref(),
            Some("mp3")
        );
        assert_eq!(
            ext("https://v.example/get?format=webm").as_deref(),
            Some("webm")
        );
        assert_eq!(ext("https://dl.example/download?token=abc"), None);
    }

    #[test]
    fn headers_say_what_a_file_is() {
        assert_eq!(extension_from_mime("audio/mpeg").as_deref(), Some("mp3"));
        assert_eq!(
            extension_from_mime("video/mp4; codecs=avc1").as_deref(),
            Some("mp4")
        );
        assert_eq!(extension_from_mime("text/html; charset=utf-8"), None);
        assert_eq!(
            extension_from_disposition("attachment; filename=\"My Clip.mp4\"").as_deref(),
            Some("mp4")
        );
        assert_eq!(
            extension_from_disposition("attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf")
                .as_deref(),
            Some("pdf")
        );
        assert_eq!(extension_from_disposition("inline"), None);
    }

    #[test]
    fn a_title_becomes_a_stem() {
        let split = |title: &str, kind| split_title(title, kind);
        let stem = |text: &str| (text.to_string(), None);
        assert_eq!(
            split("A: \"quoted\" / title?", Kind::Video),
            stem("A quoted title")
        );
        assert_eq!(split(&"é".repeat(60), Kind::Audio), stem(&"é".repeat(42)));
        assert_eq!(split("Release v2.0", Kind::Video), stem("Release v2.0"));
        assert_eq!(
            split("Google Drive File", Kind::File),
            stem("Google Drive File")
        );
        // A file name keeps its extension, known to us or not: never `report.pdf.pdf`.
        let named = |text: &str, ext: &str| (text.to_string(), Some(ext.to_string()));
        assert_eq!(split("report.pdf", Kind::File), named("report", "pdf"));
        assert_eq!(split("data.parquet", Kind::File), named("data", "parquet"));
        assert_eq!(split("Song.mp3", Kind::Audio), named("Song", "mp3"));
    }

    /// A stand-in for the service and for the host of the media, on one port.
    async fn stand_in() -> String {
        use axum::http::HeaderMap;
        use axum::routing::get;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let media = format!("{}/media?token=abc", origin);
        let app = axum::Router::new()
            .route(
                "/api/downloader/soundcloud",
                get(move |headers: HeaderMap, uri: axum::http::Uri| async move {
                    let ours =
                        headers.get("user-agent").and_then(|v| v.to_str().ok()) == Some(AGENT);
                    let asked = uri
                        .query()
                        .unwrap_or_default()
                        .contains("soundcloud.com%2Fa%2Fb");
                    if !ours || !asked {
                        return axum::Json(json!({ "status": false }));
                    }
                    axum::Json(json!({ "status": true, "title": "A track", "audio": media }))
                }),
            )
            .route(
                "/media",
                get(|| async { ([("content-type", "audio/mpeg")], "") }),
            )
            .route(
                "/api/downloader/gdrive",
                get(|| async {
                    let data =
                        json!({ "filename": "GIF.png", "downloadUrl": "http://127.0.0.1:9/x" });
                    axum::Json(json!({ "success": true, "data": data }))
                }),
            )
            .route(
                "/api/downloader/youtube",
                get(|| async { axum::Json(json!({ "status": true })) }),
            )
            .route(
                "/api/downloader/ttdl",
                get(|| async { axum::Json(json!({ "video": ["javascript:alert(1)"] })) }),
            );
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        origin
    }

    #[tokio::test]
    async fn a_page_address_becomes_the_media_behind_it() {
        let origin = stand_in().await;
        let client = reqwest::Client::new();
        let resolved = resolve_with(&client, &origin, "soundcloud", "https://soundcloud.com/a/b")
            .await
            .unwrap();
        // The address has no extension: the media host's Content-Type named the file.
        assert_eq!(
            resolved,
            Some(ResolvedLink {
                url: format!("{}/media?token=abc", origin),
                filename: "A track.mp3".to_string(),
                kind: Kind::Audio,
            })
        );
        // Named by Google Drive already: the media host, which is not even there, is not asked.
        let drive = resolve_with(
            &client,
            &origin,
            "gdrive",
            "https://drive.google.com/file/d/1",
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(
            (drive.filename.as_str(), drive.kind),
            ("GIF.png", Kind::File)
        );
        let nothing = resolve_with(&client, &origin, "youtube", "https://youtu.be/1").await;
        assert_eq!(nothing, Ok(None));
        let refused = resolve_with(&client, &origin, "ttdl", "https://tiktok.com/1").await;
        assert!(refused.unwrap_err().contains("not a web address"));
        let missing = resolve_with(&client, &origin, "igdl", "https://instagram.com/p/1").await;
        assert!(missing.unwrap_err().contains("404"));
    }
}
