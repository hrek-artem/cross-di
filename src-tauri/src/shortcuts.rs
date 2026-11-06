use crate::settings::{AppShortcut, SettingsState, get_settings};
use std::collections::HashMap;
use tauri::{State, WebviewWindow};

#[tauri::command]
pub(crate) async fn get_installed_apps(window: WebviewWindow) -> Result<Vec<AppShortcut>, String> {
    if window.label() != "settings" {
        return Err("The app catalog is only available in Settings.".into());
    }
    #[cfg(windows)]
    return tauri::async_runtime::spawn_blocking(windows_shortcuts::catalog)
        .await
        .map_err(|error| error.to_string())?;

    #[cfg(not(windows))]
    Ok(Vec::new())
}

#[tauri::command]
pub(crate) async fn get_app_icons(
    window: WebviewWindow,
    ids: Vec<String>,
) -> Result<HashMap<String, String>, String> {
    if !matches!(window.label(), "main" | "settings") || ids.len() > 6 {
        return Err("Invalid app icon request.".into());
    }
    load_app_icons(ids).await
}

pub(crate) async fn load_app_icons(ids: Vec<String>) -> Result<HashMap<String, String>, String> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    #[cfg(windows)]
    return tauri::async_runtime::spawn_blocking(move || windows_shortcuts::icons(ids))
        .await
        .map_err(|error| error.to_string())?;

    #[cfg(not(windows))]
    Ok(HashMap::new())
}

#[tauri::command]
pub(crate) async fn open_pinned_app(
    window: WebviewWindow,
    state: State<'_, SettingsState>,
    id: String,
) -> Result<(), String> {
    if window.label() != "main"
        || !get_settings(state)?
            .pinned_apps
            .iter()
            .any(|app| app.id == id)
    {
        return Err("This app is not pinned.".into());
    }

    #[cfg(windows)]
    return tauri::async_runtime::spawn_blocking(move || windows_shortcuts::open(&id))
        .await
        .map_err(|error| error.to_string())?;

    #[cfg(not(windows))]
    Err("App shortcuts are available on Windows.".into())
}

#[cfg(windows)]
mod windows_shortcuts {
    use super::AppShortcut;
    use std::collections::{HashMap, HashSet};
    use windows::{
        Win32::{
            System::Com::{
                COINIT_APARTMENTTHREADED, CoInitializeEx, CoTaskMemFree, CoUninitialize, IBindCtx,
            },
            UI::{
                Shell::{
                    BHID_EnumItems, FOLDERID_AppsFolder, IEnumShellItems, IShellItem,
                    KF_FLAG_DEFAULT, SEE_MASK_FLAG_NO_UI, SEE_MASK_IDLIST, SEE_MASK_NOASYNC,
                    SHELLEXECUTEINFOW, SHGetIDListFromObject, SHGetKnownFolderItem, SIGDN,
                    SIGDN_DESKTOPABSOLUTEPARSING, SIGDN_NORMALDISPLAY, ShellExecuteExW,
                },
                WindowsAndMessaging::SW_SHOWNORMAL,
            },
        },
        core::{Error, Result},
    };

    fn with_shell<T>(work: impl FnOnce() -> Result<T>) -> Result<T> {
        unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok()? };
        let result = work();
        unsafe { CoUninitialize() };
        result
    }

    fn apps() -> Result<IEnumShellItems> {
        unsafe {
            let folder: IShellItem =
                SHGetKnownFolderItem(&FOLDERID_AppsFolder, KF_FLAG_DEFAULT, None)?;
            folder.BindToHandler(None::<&IBindCtx>, &BHID_EnumItems)
        }
    }

    fn next_app(items: &IEnumShellItems) -> Result<Option<IShellItem>> {
        let mut slot = [None];
        unsafe { items.Next(&mut slot, None)? };
        Ok(slot[0].take())
    }

    fn name(item: &IShellItem, kind: SIGDN) -> Result<String> {
        unsafe {
            let name = item.GetDisplayName(kind)?;
            let text = name.to_string();
            CoTaskMemFree(Some(name.0.cast()));
            text.map_err(|_| Error::empty())
        }
    }

    pub(super) fn catalog() -> std::result::Result<Vec<AppShortcut>, String> {
        with_shell(|| {
            let items = apps()?;
            let mut shortcuts = Vec::new();
            let mut seen = HashSet::new();
            while let Some(item) = next_app(&items)? {
                if let (Ok(id), Ok(label)) = (
                    name(&item, SIGDN_DESKTOPABSOLUTEPARSING),
                    name(&item, SIGDN_NORMALDISPLAY),
                ) && !id.is_empty()
                    && id.len() <= 4096
                    && !label.trim().is_empty()
                    && label.len() <= 512
                    && seen.insert(id.clone())
                {
                    shortcuts.push(AppShortcut { id, label });
                }
            }
            shortcuts.sort_by_cached_key(|app| app.label.to_lowercase());
            Ok(shortcuts)
        })
        .map_err(|error| error.to_string())
    }

    pub(super) fn icons(ids: Vec<String>) -> std::result::Result<HashMap<String, String>, String> {
        with_shell(|| {
            let mut remaining: HashSet<_> = ids.into_iter().collect();
            let items = apps()?;
            let mut icons = HashMap::new();
            while !remaining.is_empty() {
                let Some(item) = next_app(&items)? else { break };
                if let Ok(id) = name(&item, SIGDN_DESKTOPABSOLUTEPARSING)
                    && remaining.remove(&id)
                    && let Some(icon) = crate::shortcut_icon::load(&item)
                {
                    icons.insert(id, icon);
                }
            }
            Ok(icons)
        })
        .map_err(|error| error.to_string())
    }

    pub(super) fn open(id: &str) -> std::result::Result<(), String> {
        let opened = with_shell(|| {
            let items = apps()?;
            while let Some(item) = next_app(&items)? {
                if name(&item, SIGDN_DESKTOPABSOLUTEPARSING).ok().as_deref() == Some(id) {
                    unsafe {
                        let pidl = SHGetIDListFromObject(&item)?;
                        let mut launch = SHELLEXECUTEINFOW {
                            cbSize: size_of::<SHELLEXECUTEINFOW>() as u32,
                            fMask: SEE_MASK_IDLIST | SEE_MASK_FLAG_NO_UI | SEE_MASK_NOASYNC,
                            lpIDList: pidl.cast(),
                            nShow: SW_SHOWNORMAL.0,
                            ..Default::default()
                        };
                        let result = ShellExecuteExW(&mut launch);
                        CoTaskMemFree(Some(pidl.cast()));
                        result?;
                    }
                    return Ok(true);
                }
            }
            Ok(false)
        })
        .map_err(|error| error.to_string())?;
        opened
            .then_some(())
            .ok_or_else(|| "This app is no longer installed.".into())
    }
}
