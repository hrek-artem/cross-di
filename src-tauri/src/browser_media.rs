mod server;
pub(crate) mod video;

use crate::media::{MediaIdentity, NowPlaying, PlaybackAction};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, mpsc},
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager, State, WebviewWindow};

const PORT: u16 = 43191;
const SESSION_TTL: Duration = Duration::from_secs(6);

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    id: String,
    title: String,
    artist: String,
    source_name: String,
    playing: bool,
    position: f64,
    duration: f64,
    rate: f64,
    can_toggle: bool,
    can_previous: bool,
    can_next: bool,
    can_seek: bool,
    #[serde(default)]
    can_set_volume: bool,
    #[serde(default = "full_volume")]
    volume: f64,
    artwork: Option<String>,
}

fn full_volume() -> f64 {
    1.0
}

struct Entry {
    client: String,
    snapshot: Snapshot,
    seen: Instant,
    changed: Instant,
    artwork_revision: u64,
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Action {
    Toggle,
    Previous,
    Next,
    Seek { seconds: f64 },
    Volume { level: f64 },
    Open,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Command {
    id: u64,
    session: String,
    title: String,
    artist: String,
    action: Action,
}

struct Pending {
    client: String,
    command: Command,
    reply: mpsc::Sender<bool>,
    deadline: Instant,
    sent: bool,
}

#[derive(Default)]
struct Inner {
    sessions: HashMap<String, Entry>,
    pending: Vec<Pending>,
    next_command: u64,
    last_sync: Option<Instant>,
    video: HashMap<String, video::Video>,
    video_status: String,
}

pub(crate) struct Bridge {
    token: String,
    error: Option<String>,
    notify: Option<Box<dyn Fn() + Send + Sync>>,
    inner: Mutex<Inner>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncPacket {
    client_id: String,
    sessions: Vec<Snapshot>,
    #[serde(default)]
    acknowledgements: Vec<Acknowledgement>,
    #[serde(default)]
    video: Option<video::Offer>,
    #[serde(default)]
    video_status: String,
}

#[derive(Deserialize)]
struct Acknowledgement {
    id: u64,
    success: bool,
}

pub(crate) fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    if let Err(error) = crate::browser_native::register() {
        eprintln!("Browser connection setup: {error}");
    }
    let directory = app.path().app_config_dir()?;
    std::fs::create_dir_all(&directory)?;
    let path = directory.join("browser-connection.key");
    let token = std::fs::read_to_string(&path)
        .ok()
        .filter(|s| valid_id(s) && s.len() == 64)
        .unwrap_or_else(|| {
            let mut bytes = [0u8; 32];
            getrandom::fill(&mut bytes).expect("System random generator unavailable");
            bytes.iter().map(|byte| format!("{byte:02x}")).collect()
        });
    if !path.exists() || std::fs::read_to_string(&path).ok().as_deref() != Some(&token) {
        use std::io::Write;
        let mut file = tempfile::NamedTempFile::new_in(&directory)?;
        file.write_all(token.as_bytes())?;
        file.persist(&path)?;
    }
    let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, PORT));
    let bridge = Arc::new(Bridge {
        token,
        error: listener.as_ref().err().map(|error| error.to_string()),
        notify: Some(Box::new({
            let app = app.handle().clone();
            move || {
                let _ = app.emit_to("main", "browser-media-changed", ());
            }
        })),
        inner: Mutex::new(Inner::default()),
    });
    if let Ok(listener) = listener {
        let service = Arc::clone(&bridge);
        std::thread::Builder::new()
            .name("browser-media".into())
            .spawn(move || server::run(listener, service))?;
    }
    app.manage(bridge);
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectionStatus {
    connected: bool,
    error: Option<String>,
    extension_path: Option<String>,
}

#[tauri::command]
pub(crate) fn get_browser_connection(
    window: WebviewWindow,
    bridge: State<'_, Arc<Bridge>>,
) -> Result<ConnectionStatus, String> {
    if window.label() != "settings" {
        return Err("Only available in Settings.".into());
    }
    let inner = bridge.inner.lock().map_err(|error| error.to_string())?;
    Ok(ConnectionStatus {
        connected: inner.last_sync.is_some_and(|at| at.elapsed() < SESSION_TTL),
        error: bridge.error.clone(),
        extension_path: crate::browser_native::extension_directory(window.app_handle())
            .ok()
            .map(|p| p.display().to_string()),
    })
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_:".contains(&b))
}

fn source(client: &str, session: &str) -> String {
    format!("browser:{client}:{session}")
}

impl Bridge {
    fn sync(&self, packet: SyncPacket) -> Result<Vec<Command>, ()> {
        if !valid_id(&packet.client_id)
            || packet.sessions.len() > 32
            || packet.acknowledgements.len() > 32
            || packet
                .video
                .as_ref()
                .is_some_and(|offer| !video::valid_offer(offer))
            || packet.video_status.len() > 1024
        {
            return Err(());
        }
        for snapshot in &packet.sessions {
            if !valid_id(&snapshot.id)
                || snapshot.title.len() > 2048
                || snapshot.artist.len() > 1024
                || snapshot.source_name.len() > 256
                || snapshot.title.trim().is_empty()
                || !snapshot.position.is_finite()
                || !snapshot.duration.is_finite()
                || !snapshot.rate.is_finite()
                || !snapshot.volume.is_finite()
                || !(0.0..=1.0).contains(&snapshot.volume)
                || snapshot.position < 0.0
                || snapshot.duration < 0.0
                || !(0.0..=16.0).contains(&snapshot.rate)
                || snapshot.artwork.as_ref().is_some_and(|art| {
                    art.len() > 64 * 1024 || !art.starts_with("data:image/jpeg;base64,")
                })
            {
                return Err(());
            }
        }
        let now = Instant::now();
        let mut inner = self.inner.lock().map_err(|_| ())?;
        inner.last_sync = Some(now);
        inner.video_status = packet.video_status.clone();
        inner.sessions.retain(|_, entry| {
            entry.seen.elapsed() < SESSION_TTL
                && (entry.client != packet.client_id
                    || packet.sessions.iter().any(|s| s.id == entry.snapshot.id))
        });
        for snapshot in packet.sessions {
            let key = source(&packet.client_id, &snapshot.id);
            let artwork_revision = inner.sessions.get(&key).map_or(0, |old| {
                old.artwork_revision + u64::from(old.snapshot.artwork != snapshot.artwork)
            });
            let changed = inner
                .sessions
                .get(&key)
                .filter(|old| {
                    old.snapshot.title == snapshot.title
                        && old.snapshot.artist == snapshot.artist
                        && old.snapshot.playing == snapshot.playing
                })
                .map_or(now, |old| old.changed);
            inner.sessions.insert(
                key,
                Entry {
                    client: packet.client_id.clone(),
                    snapshot,
                    seen: now,
                    changed,
                    artwork_revision,
                },
            );
        }
        inner.pending.retain(|pending| {
            if pending.client == packet.client_id
                && let Some(ack) = packet
                    .acknowledgements
                    .iter()
                    .find(|ack| ack.id == pending.command.id)
            {
                let _ = pending.reply.send(ack.success);
                return false;
            }
            pending.deadline > now
        });
        video::update(&mut inner, &packet.client_id, packet.video, now);
        let mut commands = Vec::new();
        for pending in &mut inner.pending {
            if pending.client == packet.client_id && !pending.sent {
                commands.push(pending.command.clone());
                pending.sent = true;
            }
        }
        drop(inner);
        if let Some(notify) = &self.notify {
            notify();
        }
        Ok(commands)
    }

    pub(crate) fn now_playing(&self) -> Option<NowPlaying> {
        let inner = self.inner.lock().ok()?;
        let (key, entry) = inner
            .sessions
            .iter()
            .filter(|(_, e)| e.seen.elapsed() < SESSION_TTL)
            .max_by_key(|(_, e)| (e.snapshot.playing, e.changed))?;
        let track = &entry.snapshot;
        Some(NowPlaying {
            title: track.title.clone(),
            artist: track.artist.clone(),
            source_app: key.clone(),
            source_name: track.source_name.clone(),
            playing: track.playing,
            position: (track.position + entry.seen.elapsed().as_secs_f64() * track.rate)
                .min(track.duration),
            duration: track.duration,
            rate: track.rate,
            artwork_revision: entry.artwork_revision,
            can_toggle: track.can_toggle,
            can_previous: track.can_previous,
            can_next: track.can_next,
            can_seek: track.can_seek,
            can_set_volume: track.can_set_volume,
            volume: track.volume,
        })
    }

    pub(crate) fn artwork(&self, media: &MediaIdentity) -> Option<String> {
        let inner = self.inner.lock().ok()?;
        let entry = inner.sessions.get(&media.source_app)?;
        (entry.seen.elapsed() < SESSION_TTL
            && entry.snapshot.title == media.title
            && entry.snapshot.artist == media.artist)
            .then(|| entry.snapshot.artwork.clone())
            .flatten()
    }

    fn request(&self, source: &str, identity: Option<&MediaIdentity>, action: Action) -> bool {
        let (sender, receiver) = mpsc::channel();
        {
            let Ok(mut inner) = self.inner.lock() else {
                return false;
            };
            let Some(entry) = inner.sessions.get(source) else {
                return false;
            };
            if entry.seen.elapsed() >= SESSION_TTL
                || identity.is_some_and(|m| {
                    entry.snapshot.title != m.title || entry.snapshot.artist != m.artist
                })
                || inner.pending.len() >= 16
            {
                return false;
            }
            let client = entry.client.clone();
            let session = entry.snapshot.id.clone();
            let title = entry.snapshot.title.clone();
            let artist = entry.snapshot.artist.clone();
            inner.next_command += 1;
            let id = inner.next_command;
            inner.pending.push(Pending {
                client,
                command: Command {
                    id,
                    session,
                    title,
                    artist,
                    action,
                },
                reply: sender,
                deadline: Instant::now() + Duration::from_secs(3),
                sent: false,
            });
        }
        receiver
            .recv_timeout(Duration::from_secs(3))
            .unwrap_or(false)
    }

    pub(crate) fn control(&self, media: &MediaIdentity, action: PlaybackAction) -> bool {
        let action = match action {
            PlaybackAction::Volume { level }
                if level.is_finite() && (0.0..=1.0).contains(&level) =>
            {
                Action::Volume { level }
            }
            PlaybackAction::Toggle => Action::Toggle,
            PlaybackAction::Previous => Action::Previous,
            PlaybackAction::Next => Action::Next,
            PlaybackAction::Seek { seconds } if seconds.is_finite() && seconds >= 0.0 => {
                Action::Seek { seconds }
            }
            _ => return false,
        };
        self.request(&media.source_app, Some(media), action)
    }

    pub(crate) fn open(&self, source: &str) -> bool {
        self.request(source, None, Action::Open)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bridge() -> Arc<Bridge> {
        Arc::new(Bridge {
            token: "a".repeat(64),
            error: None,
            notify: None,
            inner: Mutex::new(Inner::default()),
        })
    }

    fn packet() -> SyncPacket {
        serde_json::from_value(serde_json::json!({
            "clientId": "edge-test", "sessions": [{
                "id": "10:0", "title": "Test song", "artist": "Artist", "sourceName": "YouTube · Edge",
                "playing": true, "position": 12.0, "duration": 180.0, "rate": 1.0,
                "canToggle": true, "canPrevious": false, "canNext": true, "canSeek": true, "artwork": null
            }]
        })).unwrap()
    }

    #[test]
    fn snapshots_update_cover_keep_pause_and_expire_on_disconnect() {
        let bridge = bridge();
        bridge.sync(packet()).unwrap();
        let track = bridge.now_playing().unwrap();
        assert_eq!(track.source_name, "YouTube · Edge");
        assert!(track.position >= 12.0 && track.position < 13.0);
        let identity = MediaIdentity {
            source_app: track.source_app,
            title: track.title,
            artist: track.artist,
        };
        let mut paused = packet();
        paused.sessions[0].playing = false;
        paused.sessions[0].rate = 0.0;
        paused.sessions[0].artwork = Some("data:image/jpeg;base64,/9j/".into());
        bridge.sync(paused).unwrap();
        let track = bridge.now_playing().unwrap();
        assert!(!track.playing);
        assert_eq!(track.position, 12.0);
        assert_eq!(track.artwork_revision, 1);
        assert!(bridge.artwork(&identity).is_some());
        bridge
            .inner
            .lock()
            .unwrap()
            .sessions
            .values_mut()
            .for_each(|entry| entry.seen -= SESSION_TTL);
        assert!(bridge.now_playing().is_none());
        assert!(bridge.artwork(&identity).is_none());
    }

    #[test]
    fn closing_tab_removes_track_and_invalid_data_is_rejected() {
        let bridge = bridge();
        bridge.sync(packet()).unwrap();
        let mut empty = packet();
        empty.sessions.clear();
        bridge.sync(empty).unwrap();
        assert!(bridge.now_playing().is_none());
        let mut invalid = packet();
        invalid.sessions[0].rate = f64::NAN;
        assert!(bridge.sync(invalid).is_err());
        let mut invalid = packet();
        invalid.sessions[0].artwork = Some("https://example.com/private".into());
        assert!(bridge.sync(invalid).is_err());
    }

    #[test]
    fn volume_is_optional_for_old_extensions_and_invalid_levels_are_rejected() {
        let bridge = bridge();
        let snapshot = packet();
        assert_eq!(snapshot.sessions[0].volume, 1.0);
        assert!(!snapshot.sessions[0].can_set_volume);
        bridge.sync(snapshot).unwrap();
        let track = bridge.now_playing().unwrap();
        let identity = MediaIdentity {
            source_app: track.source_app,
            title: track.title,
            artist: track.artist,
        };
        for level in [f64::NAN, -0.1, 1.1] {
            assert!(!bridge.control(&identity, PlaybackAction::Volume { level }));
            let mut invalid = packet();
            invalid.sessions[0].volume = level;
            assert!(bridge.sync(invalid).is_err());
        }
    }

    #[test]
    fn commands_target_exact_track_are_sent_once_and_wait_for_ack() {
        let bridge = bridge();
        bridge.sync(packet()).unwrap();
        let track = bridge.now_playing().unwrap();
        let mut identity = MediaIdentity {
            source_app: track.source_app,
            title: "Wrong track".into(),
            artist: track.artist,
        };
        assert!(!bridge.control(&identity, PlaybackAction::Toggle));
        identity.title = track.title;
        let worker = Arc::clone(&bridge);
        let result = std::thread::spawn(move || worker.control(&identity, PlaybackAction::Toggle));
        let deadline = Instant::now() + Duration::from_secs(2);
        let command = loop {
            let commands = bridge.sync(packet()).unwrap();
            if let Some(command) = commands.into_iter().next() {
                break command;
            }
            assert!(Instant::now() < deadline, "No browser command queued");
            std::thread::sleep(Duration::from_millis(2));
        };
        assert_eq!(command.session, "10:0");
        assert_eq!(command.title, "Test song");
        assert!(bridge.sync(packet()).unwrap().is_empty());
        let mut ack = packet();
        ack.acknowledgements.push(Acknowledgement {
            id: command.id,
            success: true,
        });
        bridge.sync(ack).unwrap();
        assert!(result.join().unwrap());
    }
}
