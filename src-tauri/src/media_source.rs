use std::path::{Component, Path, Prefix};
use windows::{
    Win32::{
        Foundation::{CloseHandle, HWND, LPARAM},
        System::{
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
                TH32CS_SNAPPROCESS,
            },
            Threading::{
                OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
                QueryFullProcessImageNameW,
            },
        },
        UI::{
            Shell::{
                FOLDERID_AppsFolder, IShellItem, KF_FLAG_DEFAULT, SHCreateItemInKnownFolder,
                ShellExecuteW,
            },
            WindowsAndMessaging::{
                EnumWindows, GetWindowThreadProcessId, IsIconic, IsWindowVisible, SW_RESTORE,
                SW_SHOWNORMAL, SetForegroundWindow, ShowWindowAsync,
            },
        },
    },
    core::{BOOL, HSTRING, PCWSTR, PWSTR, w},
};

pub(crate) fn open(source: &str) -> bool {
    // Browsers often publish an AppUserModelID (e.g. MSEdge.<profile>),
    // rather than their executable name. Resolve it to a running browser.
    let running = running_app(source)
        .or_else(|| browser(source).and_then(|(_, executable)| running_app(executable)));
    if let Some(app) = &running
        && focus_window(&app.processes)
    {
        return true;
    }

    if let Some(target) = registered_app(source)
        && shell_open(&target)
    {
        return true;
    }

    // Only launch an executable when its path was verified against a running process.
    running.is_some_and(|app| shell_open(&HSTRING::from(app.path)))
}

pub(crate) fn name(source: &str) -> String {
    if let Some((name, _)) = browser(source) {
        return name.into();
    }
    let name = source.rsplit(['\\', '/', '!']).next().unwrap_or(source);
    let name = name.strip_suffix(".exe").unwrap_or(name);
    if name.eq_ignore_ascii_case("spotify") {
        "Spotify".into()
    } else if name.is_empty() {
        "source app".into()
    } else {
        name.into()
    }
}

fn browser(source: &str) -> Option<(&'static str, &'static str)> {
    let source = source.rsplit(['\\', '/']).next()?.to_ascii_lowercase();
    let source = source.strip_suffix(".exe").unwrap_or(&source);
    let browsers: &[(&[&str], &str, &str)] = &[
        (&["chrome", "google.chrome"], "Chrome", "chrome.exe"),
        (
            &["msedge", "microsoft.edge", "microsoft.microsoftedge"],
            "Microsoft Edge",
            "msedge.exe",
        ),
        (
            &["firefox", "org.mozilla.firefox"],
            "Firefox",
            "firefox.exe",
        ),
        (&["brave", "bravebrowser"], "Brave", "brave.exe"),
        (&["opera", "operagx", "opera gx"], "Opera", "opera.exe"),
        (&["vivaldi"], "Vivaldi", "vivaldi.exe"),
        (
            &["yandex", "yandexbrowser", "yandex.browser", "browser"],
            "Yandex Browser",
            "browser.exe",
        ),
        (&["chromium"], "Chromium", "chrome.exe"),
    ];
    browsers.iter().find_map(|(ids, name, executable)| {
        ids.iter()
            .any(|id| {
                source == *id
                    || source
                        .strip_prefix(id)
                        .is_some_and(|suffix| suffix.starts_with(['.', '!', '_']))
            })
            .then_some((*name, *executable))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_browser_executables_and_profile_ids() {
        assert_eq!(browser("chrome.exe"), Some(("Chrome", "chrome.exe")));
        assert_eq!(
            browser("MSEdge.Default"),
            Some(("Microsoft Edge", "msedge.exe"))
        );
        assert_eq!(browser("Chrome.Profile 1"), Some(("Chrome", "chrome.exe")));
        assert_eq!(
            browser("org.mozilla.firefox_123"),
            Some(("Firefox", "firefox.exe"))
        );
        assert_eq!(
            browser(r"C:\Program Files\BraveSoftware\brave.exe"),
            Some(("Brave", "brave.exe"))
        );
        assert_eq!(browser("chrome-malware.exe"), None);
        assert_eq!(browser("Spotify.exe"), None);
        assert_eq!(name("Spotify.exe"), "Spotify");
    }
}

fn registered_app(source: &str) -> Option<HSTRING> {
    if source.is_empty()
        || !source
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || "._!- ".contains(ch))
    {
        return None;
    }
    let id = HSTRING::from(source);
    let _: IShellItem =
        unsafe { SHCreateItemInKnownFolder(&FOLDERID_AppsFolder, KF_FLAG_DEFAULT, &id).ok()? };
    Some(HSTRING::from(format!("shell:AppsFolder\\{source}")))
}

fn shell_open(target: &HSTRING) -> bool {
    let result = unsafe {
        ShellExecuteW(
            None,
            w!("open"),
            target,
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    result.0 as isize > 32
}

struct RunningApp {
    path: String,
    processes: Vec<u32>,
}

fn local_executable(path: &Path) -> bool {
    path.is_absolute()
        && matches!(path.components().next(), Some(Component::Prefix(prefix))
            if matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_)))
        && path
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"))
}

fn running_app(source: &str) -> Option<RunningApp> {
    let path = Path::new(source);
    let absolute = path.is_absolute();
    let name = path.file_name()?.to_str()?;
    let executable = if absolute && local_executable(path)
        || !absolute && source.eq(name) && name.to_ascii_lowercase().ends_with(".exe")
    {
        name.to_owned()
    } else if source == name
        && name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    {
        format!("{name}.exe")
    } else {
        return None;
    };

    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).ok()?;
        let mut entry = PROCESSENTRY32W {
            dwSize: size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        let mut status = Process32FirstW(snapshot, &mut entry);
        let mut app: Option<RunningApp> = None;
        while status.is_ok() {
            let name = String::from_utf16_lossy(&entry.szExeFile);
            if name
                .trim_end_matches('\0')
                .eq_ignore_ascii_case(&executable)
                && let Some(process_path) = process_path(entry.th32ProcessID)
                && (!absolute || process_path.eq_ignore_ascii_case(source))
                && local_executable(Path::new(&process_path))
            {
                let app = app.get_or_insert_with(|| RunningApp {
                    path: process_path.clone(),
                    processes: Vec::new(),
                });
                if app.path.eq_ignore_ascii_case(&process_path) {
                    app.processes.push(entry.th32ProcessID);
                }
            }
            status = Process32NextW(snapshot, &mut entry);
        }
        let _ = CloseHandle(snapshot);
        app
    }
}

fn process_path(pid: u32) -> Option<String> {
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut path = vec![0u16; 32_768];
        let mut size = path.len() as u32;
        let read = QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            PWSTR(path.as_mut_ptr()),
            &mut size,
        );
        let _ = CloseHandle(process);
        read.ok()?;
        String::from_utf16(&path[..size as usize]).ok()
    }
}

struct WindowSearch<'a> {
    processes: &'a [u32],
    found: Option<HWND>,
}

fn focus_window(processes: &[u32]) -> bool {
    let mut search = WindowSearch {
        processes,
        found: None,
    };
    unsafe {
        let _ = EnumWindows(
            Some(find_window),
            LPARAM((&mut search as *mut WindowSearch<'_>) as isize),
        );
        let Some(window) = search.found else {
            return false;
        };
        if IsIconic(window).as_bool() {
            let _ = ShowWindowAsync(window, SW_RESTORE);
        }
        SetForegroundWindow(window).as_bool()
    }
}

unsafe extern "system" fn find_window(hwnd: HWND, data: LPARAM) -> BOOL {
    // EnumWindows calls this synchronously while the stack-allocated search is alive.
    let search = unsafe { &mut *(data.0 as *mut WindowSearch<'_>) };
    let mut pid = 0;
    if unsafe { IsWindowVisible(hwnd).as_bool() } {
        unsafe {
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
        }
        if search.processes.contains(&pid) {
            search.found = Some(hwnd);
            return BOOL(0);
        }
    }
    BOOL(1)
}
