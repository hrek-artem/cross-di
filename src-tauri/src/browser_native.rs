use serde::Deserialize;
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
};
use tauri::Manager;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Config {
    host_name: String,
    extension_id: String,
}

fn config() -> Config {
    serde_json::from_str(include_str!("../../extensions/browser-config.json"))
        .expect("Invalid browser configuration")
}

fn directory() -> Result<PathBuf, String> {
    std::env::var_os("APPDATA")
        .map(|path| PathBuf::from(path).join("xanksax.cross-di"))
        .ok_or("Application configuration directory is unavailable.".into())
}

pub(crate) fn extension_directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let bundled = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("browser-extension");
    if bundled.join("manifest.json").is_file() {
        return Ok(bundled);
    }
    #[cfg(debug_assertions)]
    {
        let development = Path::new(env!("CARGO_MANIFEST_DIR")).join("../extensions/chromium");
        if development.join("manifest.json").is_file() {
            return development.canonicalize().map_err(|e| e.to_string());
        }
    }
    Err("The browser extension is missing from this installation.".into())
}

#[tauri::command]
pub(crate) fn prepare_browser_extension(
    window: tauri::WebviewWindow,
    browser: String,
) -> Result<(), String> {
    if window.label() != "settings" || !matches!(browser.as_str(), "edge" | "chrome") {
        return Err("Invalid browser setup request.".into());
    }
    register()?;
    let folder = extension_directory(window.app_handle())?;
    #[cfg(windows)]
    {
        use windows::{
            Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL},
            core::{HSTRING, PCWSTR, w},
        };
        unsafe {
            let result = ShellExecuteW(
                None,
                w!("open"),
                &HSTRING::from(folder.as_os_str()),
                PCWSTR::null(),
                PCWSTR::null(),
                SW_SHOWNORMAL,
            );
            if result.0 as isize <= 32 {
                return Err("Could not open the extension folder.".into());
            }
            let (program, page) = if browser == "edge" {
                ("msedge.exe", "edge://extensions/")
            } else {
                ("chrome.exe", "chrome://extensions/")
            };
            let _ = ShellExecuteW(
                None,
                w!("open"),
                &HSTRING::from(program),
                &HSTRING::from(page),
                PCWSTR::null(),
                SW_SHOWNORMAL,
            );
        }
    }
    Ok(())
}

pub(crate) fn register() -> Result<(), String> {
    #[cfg(windows)]
    {
        let config = config();
        let directory = directory()?;
        std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        let manifest = directory.join("browser-native-host.json");
        let executable = std::env::current_exe().map_err(|e| e.to_string())?;
        let data = serde_json::json!({ "name": config.host_name, "description": "Cross Dynamic Island browser connection", "path": executable, "type": "stdio", "allowed_origins": [format!("chrome-extension://{}/", config.extension_id)] });
        let mut file = tempfile::NamedTempFile::new_in(&directory).map_err(|e| e.to_string())?;
        file.write_all(data.to_string().as_bytes())
            .map_err(|e| e.to_string())?;
        file.persist(&manifest).map_err(|e| e.to_string())?;
        registry(&manifest, false)?;
    }
    Ok(())
}

#[cfg(windows)]
fn registry(manifest: &Path, remove: bool) -> Result<(), String> {
    use windows::{
        Win32::System::Registry::{
            HKEY, HKEY_CURRENT_USER, REG_SZ, RegCloseKey, RegCreateKeyW, RegDeleteTreeW,
            RegSetValueExW,
        },
        core::{HSTRING, PCWSTR},
    };
    for browser in ["Google\\Chrome", "Microsoft\\Edge"] {
        let key = HSTRING::from(format!(
            "Software\\{browser}\\NativeMessagingHosts\\{}",
            config().host_name
        ));
        unsafe {
            if remove {
                let _ = RegDeleteTreeW(HKEY_CURRENT_USER, &key);
                continue;
            }
            let mut handle = HKEY::default();
            RegCreateKeyW(HKEY_CURRENT_USER, &key, &mut handle)
                .ok()
                .map_err(|e| e.to_string())?;
            let value: Vec<u16> = manifest
                .as_os_str()
                .to_string_lossy()
                .encode_utf16()
                .chain(Some(0))
                .collect();
            let bytes: Vec<u8> = value.iter().flat_map(|v| v.to_le_bytes()).collect();
            let result = RegSetValueExW(handle, PCWSTR::null(), None, REG_SZ, Some(&bytes));
            let _ = RegCloseKey(handle);
            result.ok().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn respond(input: &mut impl Read, output: &mut impl Write) -> Result<(), String> {
    let mut prefix = [0; 4];
    input.read_exact(&mut prefix).map_err(|e| e.to_string())?;
    let length = u32::from_le_bytes(prefix) as usize;
    if length > 4096 {
        return Err("Native request is too large.".into());
    }
    let mut bytes = vec![0; length];
    input.read_exact(&mut bytes).map_err(|e| e.to_string())?;
    let message: serde_json::Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    if message["type"] != "connect" {
        return Err("Unsupported native request.".into());
    }
    let token = std::fs::read_to_string(directory()?.join("browser-connection.key"))
        .map_err(|_| "Start Dynamic Island before connecting.".to_string())?;
    if token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Invalid connection credential.".into());
    }
    write_message(
        output,
        &serde_json::json!({ "token": token, "protocol": 2 }),
    )
}

fn write_message(output: &mut impl Write, value: &serde_json::Value) -> Result<(), String> {
    let bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    output
        .write_all(&(bytes.len() as u32).to_le_bytes())
        .and_then(|_| output.write_all(&bytes))
        .and_then(|_| output.flush())
        .map_err(|e| e.to_string())
}

pub fn handle_arguments() -> bool {
    let Some(argument) = std::env::args().nth(1) else {
        return false;
    };
    if argument == "--register-browser-host" {
        if let Err(error) = register() {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return true;
    }
    if argument == "--unregister-browser-host" {
        #[cfg(windows)]
        if let Ok(path) = directory() {
            let manifest = path.join("browser-native-host.json");
            let installed = std::fs::read(&manifest)
                .ok()
                .and_then(|data| serde_json::from_slice::<serde_json::Value>(&data).ok())
                .and_then(|value| value["path"].as_str().map(PathBuf::from));
            if installed == std::env::current_exe().ok() {
                let _ = registry(&manifest, true);
            }
        }
        return true;
    }
    if !argument.starts_with("chrome-extension://") {
        return false;
    }
    if argument == format!("chrome-extension://{}/", config().extension_id) {
        let mut output = std::io::stdout().lock();
        if let Err(error) = respond(&mut std::io::stdin().lock(), &mut output) {
            let _ = write_message(&mut output, &serde_json::json!({ "error": error }));
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_framing_is_binary_and_rejects_oversized_input() {
        let mut output = Vec::new();
        write_message(&mut output, &serde_json::json!({"message": "line\nnext"})).unwrap();
        let length = u32::from_le_bytes(output[..4].try_into().unwrap()) as usize;
        assert_eq!(length, output.len() - 4);
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&output[4..]).unwrap()["message"],
            "line\nnext"
        );
        assert!(respond(&mut &5000u32.to_le_bytes()[..], &mut Vec::new()).is_err());
    }
}
