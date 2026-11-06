mod browser_media;
mod browser_native;
pub use browser_native::handle_arguments as handle_browser_arguments;
mod island;
mod media;
#[cfg(windows)]
mod media_artwork;
#[cfg(windows)]
mod media_source;
mod settings;
#[cfg(windows)]
mod shortcut_icon;
mod shortcuts;
mod system_monitor;
#[cfg(desktop)]
mod tray;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            settings::setup(app)?;
            browser_media::setup(app)?;

            #[cfg(desktop)]
            tray::setup(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            island::set_island_expanded,
            settings::get_settings,
            settings::save_settings,
            media::get_now_playing,
            media::control_playback,
            media::get_media_artwork,
            media::open_media_source,
            browser_media::get_browser_connection,
            browser_native::prepare_browser_extension,
            browser_media::video::get_browser_video,
            browser_media::video::set_browser_video_answer,
            browser_media::video::release_browser_video,
            shortcuts::get_installed_apps,
            shortcuts::open_pinned_app,
            shortcuts::get_app_icons,
            system_monitor::get_system_sample,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
