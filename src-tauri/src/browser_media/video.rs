use super::{Bridge, Command, Inner, SESSION_TTL, source, valid_id};
use serde::{Deserialize, Serialize};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tauri::{State, WebviewWindow};

#[derive(Clone, Deserialize)]
pub(super) struct Offer {
    pub id: String,
    pub session: String,
    pub sdp: String,
}

pub(super) struct Video {
    offer: Offer,
    answer: Option<String>,
    seen: Instant,
    viewer: Option<Instant>,
}

pub(super) fn valid_offer(offer: &Offer) -> bool {
    valid_id(&offer.id) && valid_id(&offer.session) && valid_sdp(&offer.sdp)
}

fn valid_sdp(sdp: &str) -> bool {
    sdp.len() <= 64 * 1024 && sdp.starts_with("v=0\r\n")
}

pub(super) fn update(inner: &mut Inner, client: &str, offer: Option<Offer>, now: Instant) {
    inner
        .video
        .retain(|_, video| video.seen.elapsed() < SESSION_TTL);
    let offer = offer.filter(|offer| inner.sessions.contains_key(&source(client, &offer.session)));
    if let Some(offer) = offer {
        match inner.video.get_mut(client) {
            Some(video)
                if video.offer.id == offer.id
                    && video.offer.session == offer.session
                    && video.offer.sdp == offer.sdp =>
            {
                video.seen = now
            }
            _ => {
                inner.video.insert(
                    client.to_owned(),
                    Video {
                        offer,
                        answer: None,
                        seen: now,
                        viewer: None,
                    },
                );
            }
        }
    } else {
        inner.video.remove(client);
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreviewOffer {
    id: String,
    source_app: String,
    sdp: String,
}

#[tauri::command]
pub(crate) fn get_browser_video(
    window: WebviewWindow,
    source_app: String,
    visible: bool,
    bridge: State<'_, Arc<Bridge>>,
) -> Result<Option<PreviewOffer>, String> {
    if window.label() != "main" {
        return Err("Only available in the island.".into());
    }
    let mut inner = bridge.inner.lock().map_err(|e| e.to_string())?;
    let Some(entry) = inner
        .sessions
        .get(&source_app)
        .filter(|e| e.seen.elapsed() < SESSION_TTL)
    else {
        return Ok(None);
    };
    let client = entry.client.clone();
    let session = entry.snapshot.id.clone();
    let Some(video) = inner
        .video
        .get_mut(&client)
        .filter(|v| v.offer.session == session && v.seen.elapsed() < SESSION_TTL)
    else {
        return Ok(None);
    };
    video.viewer = visible.then(Instant::now);
    Ok(Some(PreviewOffer {
        id: video.offer.id.clone(),
        source_app,
        sdp: video.offer.sdp.clone(),
    }))
}

#[tauri::command]
pub(crate) fn set_browser_video_answer(
    window: WebviewWindow,
    id: String,
    sdp: String,
    bridge: State<'_, Arc<Bridge>>,
) -> Result<(), String> {
    if window.label() != "main" || !valid_sdp(&sdp) {
        return Err("Invalid video answer.".into());
    }
    let mut inner = bridge.inner.lock().map_err(|e| e.to_string())?;
    let video = inner
        .video
        .values_mut()
        .find(|v| v.offer.id == id && v.seen.elapsed() < SESSION_TTL)
        .ok_or("Video session has ended.")?;
    video.answer = Some(sdp);
    Ok(())
}

#[tauri::command]
pub(crate) fn release_browser_video(
    window: WebviewWindow,
    source_app: String,
    bridge: State<'_, Arc<Bridge>>,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Only available in the island.".into());
    }
    let mut inner = bridge.inner.lock().map_err(|e| e.to_string())?;
    if let Some(client) = inner.sessions.get(&source_app).map(|e| e.client.clone())
        && let Some(video) = inner.video.get_mut(&client)
    {
        video.viewer = None;
    }
    Ok(())
}

impl Bridge {
    pub(super) fn video_response(&self, client: &str, commands: Vec<Command>) -> serde_json::Value {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let video = inner
            .video
            .get(client)
            .filter(|v| v.seen.elapsed() < SESSION_TTL);
        serde_json::json!({ "commands": commands, "videoAnswer": video.and_then(|v| v.answer.as_deref()), "videoVisible": video.is_some_and(|v| v.viewer.is_some_and(|at| at.elapsed() < Duration::from_secs(2))) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn video_offers_require_valid_session_and_bounded_sdp() {
        assert!(valid_offer(&Offer {
            id: "video-1".into(),
            session: "1:0".into(),
            sdp: "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n".into()
        }));
        assert!(!valid_offer(&Offer {
            id: "video-1".into(),
            session: "../other".into(),
            sdp: "v=0\r\n".into()
        }));
        assert!(!valid_sdp(&"x".repeat(100_000)));
    }

    #[test]
    fn video_visibility_expires_and_unknown_sessions_are_removed() {
        let mut inner = Inner::default();
        inner.video.insert(
            "client".into(),
            Video {
                offer: Offer {
                    id: "one".into(),
                    session: "1:0".into(),
                    sdp: "v=0\r\n".into(),
                },
                answer: Some("v=0\r\nanswer".into()),
                seen: Instant::now(),
                viewer: Some(Instant::now()),
            },
        );
        let bridge = Bridge {
            token: String::new(),
            error: None,
            notify: None,
            inner: std::sync::Mutex::new(inner),
        };
        assert_eq!(
            bridge.video_response("client", vec![])["videoVisible"],
            true
        );
        {
            let mut inner = bridge.inner.lock().unwrap();
            inner.video.get_mut("client").unwrap().viewer =
                Some(Instant::now() - Duration::from_secs(3));
        }
        assert_eq!(
            bridge.video_response("client", vec![])["videoVisible"],
            false
        );
        assert_eq!(
            bridge.video_response("other", vec![])["videoAnswer"],
            serde_json::Value::Null
        );
        let mut inner = bridge.inner.lock().unwrap();
        update(
            &mut inner,
            "client",
            Some(Offer {
                id: "one".into(),
                session: "1:0".into(),
                sdp: "v=0\r\n".into(),
            }),
            Instant::now(),
        );
        assert!(inner.video.is_empty());
    }
}
