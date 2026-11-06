use crate::browser_media::Bridge;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NowPlaying {
    pub(crate) title: String,
    pub(crate) artist: String,
    pub(crate) source_app: String,
    pub(crate) source_name: String,
    pub(crate) playing: bool,
    pub(crate) can_toggle: bool,
    pub(crate) can_previous: bool,
    pub(crate) can_next: bool,
    pub(crate) can_seek: bool,
    pub(crate) can_set_volume: bool,
    pub(crate) volume: f64,
    pub(crate) position: f64,
    pub(crate) duration: f64,
    pub(crate) rate: f64,
    pub(crate) artwork_revision: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaIdentity {
    pub(crate) source_app: String,
    pub(crate) title: String,
    pub(crate) artist: String,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub(crate) enum PlaybackAction {
    Toggle,
    Previous,
    Next,
    Seek { seconds: f64 },
    Volume { level: f64 },
}

#[tauri::command]
pub(crate) async fn get_now_playing(
    bridge: State<'_, Arc<Bridge>>,
) -> Result<Option<NowPlaying>, String> {
    let browser = bridge.now_playing();
    if browser.as_ref().is_some_and(|track| track.playing) {
        return Ok(browser);
    }
    #[cfg(windows)]
    {
        let native = tauri::async_runtime::spawn_blocking(windows_media::now_playing)
            .await
            .map_err(|error| error.to_string())?;
        match native {
            Ok(Some(track)) if track.playing || browser.is_none() => Ok(Some(track)),
            Ok(_) => Ok(browser),
            Err(_) if browser.is_some() => Ok(browser),
            Err(error) => Err(error),
        }
    }

    #[cfg(not(windows))]
    Ok(browser)
}

#[tauri::command]
pub(crate) async fn control_playback(
    media: MediaIdentity,
    action: PlaybackAction,
    bridge: State<'_, Arc<Bridge>>,
) -> Result<bool, String> {
    if media.source_app.starts_with("browser:") {
        let bridge = Arc::clone(&bridge);
        return tauri::async_runtime::spawn_blocking(move || bridge.control(&media, action))
            .await
            .map_err(|e| e.to_string());
    }
    #[cfg(windows)]
    return tauri::async_runtime::spawn_blocking(move || windows_media::control(&media, action))
        .await
        .map_err(|error| error.to_string())?;

    #[cfg(not(windows))]
    {
        let _ = (media, action);
        Ok(false)
    }
}

#[tauri::command]
pub(crate) async fn get_media_artwork(
    media: MediaIdentity,
    bridge: State<'_, Arc<Bridge>>,
) -> Result<Option<String>, String> {
    if media.source_app.starts_with("browser:") {
        return Ok(bridge.artwork(&media));
    }
    #[cfg(windows)]
    return tauri::async_runtime::spawn_blocking(move || windows_media::artwork(&media))
        .await
        .map_err(|error| error.to_string())?;

    #[cfg(not(windows))]
    {
        let _ = media;
        Ok(None)
    }
}

#[tauri::command]
pub(crate) async fn open_media_source(
    window: tauri::WebviewWindow,
    source_app: String,
    bridge: State<'_, Arc<Bridge>>,
) -> Result<bool, String> {
    if window.label() != "main" {
        return Err("This command only applies to the island window.".into());
    }

    if source_app.starts_with("browser:") {
        let bridge = Arc::clone(&bridge);
        return tauri::async_runtime::spawn_blocking(move || bridge.open(&source_app))
            .await
            .map_err(|e| e.to_string());
    }

    #[cfg(windows)]
    return tauri::async_runtime::spawn_blocking(move || windows_media::open_source(&source_app))
        .await
        .map_err(|error| error.to_string())?;

    #[cfg(not(windows))]
    {
        let _ = source_app;
        Ok(false)
    }
}

#[cfg(windows)]
mod windows_media {
    use super::{MediaIdentity, NowPlaying, PlaybackAction};
    use std::time::{SystemTime, UNIX_EPOCH};
    use windows::{
        Media::Control::{
            GlobalSystemMediaTransportControlsSession as Session,
            GlobalSystemMediaTransportControlsSessionManager as SessionManager,
            GlobalSystemMediaTransportControlsSessionMediaProperties as Properties,
            GlobalSystemMediaTransportControlsSessionPlaybackStatus as PlaybackStatus,
        },
        Win32::System::WinRT::{RO_INIT_MULTITHREADED, RoInitialize, RoUninitialize},
        core::Result,
    };

    const TICKS_PER_SECOND: f64 = 10_000_000.0;
    const WINRT_UNIX_EPOCH_SECONDS: f64 = 11_644_473_600.0;

    fn seconds(ticks: i64) -> f64 {
        ticks as f64 / TICKS_PER_SECOND
    }

    fn with_manager<T>(read: impl FnOnce(SessionManager) -> Result<T>) -> Result<T> {
        // Each blocking worker needs an initialized WinRT apartment for the session APIs.
        unsafe { RoInitialize(RO_INIT_MULTITHREADED)? };
        let result = (|| {
            let manager = SessionManager::RequestAsync()?.join()?;
            read(manager)
        })();
        unsafe { RoUninitialize() };
        result
    }

    fn session_priority(status: PlaybackStatus, current: bool) -> Option<u8> {
        if status == PlaybackStatus::Closed {
            None
        } else {
            // A playing browser must take precedence over a paused desktop player.
            Some(u8::from(status != PlaybackStatus::Playing) * 2 + u8::from(!current))
        }
    }

    fn sessions(manager: &SessionManager) -> Result<Vec<Session>> {
        let current = manager.GetCurrentSession().ok();
        let available = manager.GetSessions()?;
        let mut candidates = Vec::new();
        for index in 0..available.Size()? {
            let Ok(session) = available.GetAt(index) else {
                continue;
            };
            let Ok(status) = session
                .GetPlaybackInfo()
                .and_then(|info| info.PlaybackStatus())
            else {
                continue;
            };
            if let Some(priority) = session_priority(status, current.as_ref() == Some(&session)) {
                candidates.push((priority, session));
            }
        }
        candidates.sort_by_key(|(priority, _)| *priority);
        Ok(candidates.into_iter().map(|(_, session)| session).collect())
    }

    pub(super) fn now_playing() -> std::result::Result<Option<NowPlaying>, String> {
        with_manager(|manager| {
            for session in sessions(&manager)? {
                // A session can disappear while a browser tab is closing.
                // Keep looking instead of hiding another available player.
                if let Ok(Some(track)) = read_track(&session) {
                    return Ok(Some(track));
                }
            }
            Ok(None)
        })
        .map_err(|error| error.to_string())
    }

    fn read_track(session: &Session) -> Result<Option<NowPlaying>> {
        let playback = session.GetPlaybackInfo()?;
        let status = playback.PlaybackStatus()?;
        if status == PlaybackStatus::Closed {
            return Ok(None);
        }

        let media = session.TryGetMediaPropertiesAsync()?.join()?;
        let title = media.Title()?.to_string();
        if title.trim().is_empty() {
            return Ok(None);
        }

        let controls = playback.Controls()?;
        let playing = status == PlaybackStatus::Playing;
        let rate = if playing {
            playback
                .PlaybackRate()
                .and_then(|rate| rate.Value())
                .ok()
                .filter(|rate| rate.is_finite() && *rate > 0.0)
                .unwrap_or(1.0)
        } else {
            0.0
        };
        let (position, duration) = timeline(session, rate).unwrap_or_default();
        let source_app = session.SourceAppUserModelId()?.to_string();

        Ok(Some(NowPlaying {
            title,
            artist: media.Artist()?.to_string(),
            source_name: crate::media_source::name(&source_app),
            source_app,
            playing,
            can_toggle: controls.IsPlayPauseToggleEnabled()?
                || if playing {
                    controls.IsPauseEnabled()?
                } else {
                    controls.IsPlayEnabled()?
                },
            can_previous: controls.IsPreviousEnabled()?,
            can_next: controls.IsNextEnabled()?,
            can_seek: duration > 0.0 && controls.IsPlaybackPositionEnabled()?,
            can_set_volume: false,
            volume: 1.0,
            position,
            duration,
            rate,
            artwork_revision: 0,
        }))
    }

    fn timeline(session: &Session, rate: f64) -> Result<(f64, f64)> {
        let timeline = session.GetTimelineProperties()?;
        let start = timeline.StartTime()?.Duration;
        let duration = seconds(timeline.EndTime()?.Duration.saturating_sub(start)).max(0.0);
        let position = seconds(timeline.Position()?.Duration.saturating_sub(start)).max(0.0);
        let updated = timeline.LastUpdatedTime()?.UniversalTime;
        let elapsed = if updated > 0 {
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs_f64();
            (now + WINRT_UNIX_EPOCH_SECONDS - seconds(updated)).max(0.0)
        } else {
            0.0
        };
        Ok(((position + elapsed * rate).min(duration), duration))
    }

    fn matching_properties(session: &Session, media: &MediaIdentity) -> Result<Option<Properties>> {
        if session.SourceAppUserModelId()?.to_string() != media.source_app {
            return Ok(None);
        }
        let properties = session.TryGetMediaPropertiesAsync()?.join()?;
        let matches = properties.Title()?.to_string() == media.title
            && properties.Artist()?.to_string() == media.artist;
        Ok(matches.then_some(properties))
    }

    fn with_matching_session<T>(
        media: &MediaIdentity,
        read: impl FnOnce(Session, Properties) -> Result<T>,
    ) -> Result<Option<T>> {
        with_manager(|manager| {
            for session in sessions(&manager)? {
                if let Ok(Some(properties)) = matching_properties(&session, media) {
                    return read(session, properties).map(Some);
                }
            }
            Ok(None)
        })
    }

    pub(super) fn control(
        media: &MediaIdentity,
        action: PlaybackAction,
    ) -> std::result::Result<bool, String> {
        with_matching_session(media, |session, _| {
            let operation = match action {
                PlaybackAction::Toggle => {
                    let info = session.GetPlaybackInfo()?;
                    let controls = info.Controls()?;
                    if info.PlaybackStatus()? == PlaybackStatus::Playing
                        && controls.IsPauseEnabled()?
                    {
                        session.TryPauseAsync()?
                    } else if info.PlaybackStatus()? != PlaybackStatus::Playing
                        && controls.IsPlayEnabled()?
                    {
                        session.TryPlayAsync()?
                    } else {
                        session.TryTogglePlayPauseAsync()?
                    }
                }
                PlaybackAction::Volume { .. } => return Ok(false),
                PlaybackAction::Previous => session.TrySkipPreviousAsync()?,
                PlaybackAction::Next => session.TrySkipNextAsync()?,
                PlaybackAction::Seek { seconds } => {
                    let timeline = session.GetTimelineProperties()?;
                    let start = timeline.StartTime()?.Duration;
                    let end = timeline.EndTime()?.Duration;
                    if !seconds.is_finite() || end <= start {
                        return Ok(false);
                    }
                    let seek_start = timeline.MinSeekTime()?.Duration.max(start);
                    let seek_end = timeline.MaxSeekTime()?.Duration.min(end);
                    let requested =
                        start.saturating_add((seconds * TICKS_PER_SECOND).round() as i64);
                    let position = if seek_end > seek_start {
                        requested.clamp(seek_start, seek_end)
                    } else {
                        requested.clamp(start, end)
                    };
                    session.TryChangePlaybackPositionAsync(position)?
                }
            };
            operation.join()
        })
        .map(Option::unwrap_or_default)
        .map_err(|error| error.to_string())
    }

    pub(super) fn artwork(media: &MediaIdentity) -> std::result::Result<Option<String>, String> {
        with_matching_session(media, |_, properties| {
            Ok(crate::media_artwork::cover(&properties).ok().flatten())
        })
        .map(Option::flatten)
        .map_err(|error| error.to_string())
    }

    pub(super) fn open_source(source_app: &str) -> std::result::Result<bool, String> {
        with_manager(|manager| {
            for session in sessions(&manager)? {
                if session
                    .SourceAppUserModelId()
                    .is_ok_and(|id| id.to_string() == source_app)
                {
                    return Ok(crate::media_source::open(source_app));
                }
            }
            Ok(false)
        })
        .map_err(|error| error.to_string())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        #[ignore = "Reads live Windows media sessions for local diagnostics"]
        fn live_media_diagnostics() {
            with_manager(|manager| {
                for attempt in 0..5 {
                    println!(
                        "Session snapshot {attempt}: {}",
                        manager.GetSessions()?.Size()?
                    );
                    std::thread::sleep(std::time::Duration::from_millis(500));
                }
                let available = manager.GetSessions()?;
                println!("Available sessions: {}", available.Size()?);
                for index in 0..available.Size()? {
                    let session = available.GetAt(index)?;
                    println!("Source: {:?}", session.SourceAppUserModelId());
                    println!(
                        "Playback: {:?}",
                        session
                            .GetPlaybackInfo()
                            .and_then(|info| info.PlaybackStatus())
                    );
                    match read_track(&session) {
                        Ok(track) => println!("Track: {}", serde_json::to_string(&track).unwrap()),
                        Err(error) => println!("Read error: {error:?}"),
                    }
                }
                Ok(())
            })
            .unwrap();
            println!(
                "Selected: {}",
                serde_json::to_string(&now_playing().unwrap()).unwrap()
            );
        }

        #[test]
        fn playing_browser_beats_paused_current_player() {
            assert!(
                session_priority(PlaybackStatus::Playing, false)
                    < session_priority(PlaybackStatus::Paused, true)
            );
            assert!(
                session_priority(PlaybackStatus::Playing, true)
                    < session_priority(PlaybackStatus::Playing, false)
            );
            assert!(
                session_priority(PlaybackStatus::Paused, true)
                    < session_priority(PlaybackStatus::Paused, false)
            );
            assert_eq!(session_priority(PlaybackStatus::Closed, true), None);
        }
    }
}
