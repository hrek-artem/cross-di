use crate::{island, shortcuts};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, fs, path::PathBuf, sync::Mutex};
use tauri::{App, AppHandle, Emitter, Manager, State};

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Alignment {
    Left,
    Center,
    Right,
}

#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct AppShortcut {
    pub(crate) id: String,
    pub(crate) label: String,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum IdleDisplay {
    System,
    Clock,
    Weather,
}

#[derive(Clone, Deserialize, Serialize)]
struct WeatherCity {
    id: u64,
    name: String,
    label: String,
    latitude: f64,
    longitude: f64,
}

impl WeatherCity {
    fn is_valid(&self) -> bool {
        self.id > 0
            && !self.name.trim().is_empty()
            && self.name.len() <= 240
            && !self.label.trim().is_empty()
            && self.label.len() <= 512
            && (-90.0..=90.0).contains(&self.latitude)
            && (-180.0..=180.0).contains(&self.longitude)
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct IslandSettings {
    pub(crate) alignment: Alignment,
    pub(crate) top_offset: u16,
    background_color: String,
    text_color: String,
    glass: bool,
    show_music: bool,
    open_on_hover: bool,
    idle_display: IdleDisplay,
    weather_city: Option<WeatherCity>,
    pub(crate) pinned_apps: Vec<AppShortcut>,
    pinned_app_icons: HashMap<String, String>,
}

impl Default for IslandSettings {
    fn default() -> Self {
        Self {
            alignment: Alignment::Center,
            top_offset: 0,
            background_color: "#000000".into(),
            text_color: "#ffffff".into(),
            glass: false,
            show_music: true,
            open_on_hover: false,
            idle_display: IdleDisplay::System,
            weather_city: None,
            pinned_apps: Vec::new(),
            pinned_app_icons: HashMap::new(),
        }
    }
}

impl IslandSettings {
    fn trim_icon_cache(&mut self) {
        self.pinned_app_icons.retain(|id, icon| {
            self.pinned_apps.iter().any(|app| &app.id == id)
                && icon.starts_with("data:image/png;base64,")
                && icon.len() <= 128 * 1024
        });
    }

    fn is_valid(&self) -> bool {
        let is_hex_color = |color: &str| {
            color.len() == 7
                && color.starts_with('#')
                && color.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit)
        };

        self.top_offset <= 120
            && is_hex_color(&self.background_color)
            && is_hex_color(&self.text_color)
            && (!matches!(self.idle_display, IdleDisplay::Weather) || self.weather_city.is_some())
            && self.weather_city.as_ref().is_none_or(WeatherCity::is_valid)
            && self.pinned_apps.len() <= 6
            && self.pinned_apps.iter().all(|app| {
                !app.id.is_empty()
                    && app.id.len() <= 4096
                    && !app.label.trim().is_empty()
                    && app.label.len() <= 512
            })
    }
}

pub(crate) struct SettingsState {
    path: PathBuf,
    current: Mutex<IslandSettings>,
}

pub(crate) fn setup(app: &App) -> tauri::Result<()> {
    let path = app.path().app_config_dir()?.join("island-settings.json");
    let mut settings = fs::read(&path)
        .ok()
        .and_then(|contents| serde_json::from_slice::<IslandSettings>(&contents).ok())
        .filter(IslandSettings::is_valid)
        .unwrap_or_default();
    settings.trim_icon_cache();

    app.manage(SettingsState {
        path,
        current: Mutex::new(settings.clone()),
    });
    if let Some(window) = app.get_webview_window("main") {
        island::initialize_window(&window, &settings)?;
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn get_settings(state: State<SettingsState>) -> Result<IslandSettings, String> {
    Ok(state
        .current
        .lock()
        .map_err(|error| error.to_string())?
        .clone())
}

#[tauri::command]
pub(crate) async fn save_settings(
    app: AppHandle,
    state: State<'_, SettingsState>,
    mut settings: IslandSettings,
) -> Result<IslandSettings, String> {
    if !settings.is_valid() {
        return Err("Invalid island settings.".into());
    }

    let missing_icons = {
        let current = state.current.lock().map_err(|error| error.to_string())?;
        settings
            .pinned_apps
            .iter()
            .filter(|app| !current.pinned_app_icons.contains_key(&app.id))
            .map(|app| app.id.clone())
            .collect()
    };
    let loaded_icons = shortcuts::load_app_icons(missing_icons)
        .await
        .unwrap_or_default();

    let mut current = state.current.lock().map_err(|error| error.to_string())?;
    settings.pinned_app_icons = settings
        .pinned_apps
        .iter()
        .filter_map(|app| {
            current
                .pinned_app_icons
                .get(&app.id)
                .or_else(|| loaded_icons.get(&app.id))
                .map(|icon| (app.id.clone(), icon.clone()))
        })
        .collect();
    settings.trim_icon_cache();
    let directory = state.path.parent().ok_or("Invalid settings path.")?;
    fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    let mut file = tempfile::NamedTempFile::new_in(directory).map_err(|error| error.to_string())?;
    serde_json::to_writer(&mut file, &settings).map_err(|error| error.to_string())?;
    file.as_file()
        .sync_all()
        .map_err(|error| error.to_string())?;

    let window = app
        .get_webview_window("main")
        .ok_or("Island window is unavailable.")?;
    island::position_window(&window, &settings).map_err(|error| error.to_string())?;
    if let Err(error) = file.persist(&state.path) {
        if let Err(position_error) = island::position_window(&window, &current) {
            eprintln!("Could not restore island position: {position_error}");
        }
        return Err(error.to_string());
    }

    *current = settings.clone();
    if let Err(error) = app.emit("island-settings-changed", &settings) {
        eprintln!("Could not publish island settings: {error}");
    }
    Ok(settings)
}
