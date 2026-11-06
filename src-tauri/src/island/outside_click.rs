use std::cell::RefCell;
use tauri::{Emitter, WebviewWindow};
use windows::{
    Win32::{
        Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, RECT, WPARAM},
        System::LibraryLoader::GetModuleHandleW,
        UI::WindowsAndMessaging::{
            CallNextHookEx, GetWindowRect, HC_ACTION, HHOOK, MSLLHOOKSTRUCT, PostMessageW,
            SetWindowsHookExW, UnhookWindowsHookEx, WH_MOUSE_LL, WM_APP, WM_LBUTTONDOWN,
            WM_MBUTTONDOWN, WM_RBUTTONDOWN, WM_XBUTTONDOWN,
        },
    },
    core::PCWSTR,
};

pub(super) const OUTSIDE_CLICK: u32 = WM_APP + 0x514;

struct Watch {
    hwnd: HWND,
    hook: HHOOK,
    window: WebviewWindow,
}

impl Drop for Watch {
    fn drop(&mut self) {
        unsafe {
            let _ = UnhookWindowsHookEx(self.hook);
        }
    }
}

thread_local! {
    static WATCH: RefCell<Option<Watch>> = const { RefCell::new(None) };
}

pub(super) fn watch(window: &WebviewWindow, enabled: bool) -> tauri::Result<()> {
    let island = window.clone();
    window.run_on_main_thread(move || {
        if let Err(error) = configure(island, enabled) {
            eprintln!("Could not monitor clicks outside the island: {error}");
        }
    })
}

fn configure(window: WebviewWindow, enabled: bool) -> tauri::Result<()> {
    let hwnd = window.hwnd()?;
    stop(hwnd);
    if !enabled {
        return Ok(());
    }

    let hook = unsafe {
        GetModuleHandleW(PCWSTR::null()).and_then(|module| {
            SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), Some(HINSTANCE(module.0)), 0)
        })
    }
    .map_err(std::io::Error::other)?;
    WATCH.with(|watch| watch.replace(Some(Watch { hwnd, hook, window })));
    Ok(())
}

pub(super) fn stop(hwnd: HWND) {
    let stopped = WATCH.with(|watch| {
        let mut active = watch.borrow_mut();
        if active.as_ref().is_some_and(|item| item.hwnd == hwnd) {
            active.take()
        } else {
            None
        }
    });
    drop(stopped);
}

pub(super) fn notify(hwnd: HWND) {
    let window = WATCH.with(|watch| {
        watch
            .borrow()
            .as_ref()
            .filter(|item| item.hwnd == hwnd)
            .map(|item| item.window.clone())
    });
    if let Some(window) = window {
        let _ = window.emit("island-outside-click", ());
    }
}

unsafe extern "system" fn mouse_proc(code: i32, message: WPARAM, data: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32
        && data.0 != 0
        && matches!(
            message.0 as u32,
            WM_LBUTTONDOWN | WM_RBUTTONDOWN | WM_MBUTTONDOWN | WM_XBUTTONDOWN
        )
    {
        let hwnd = WATCH.with(|watch| {
            watch
                .try_borrow()
                .ok()
                .and_then(|item| item.as_ref().map(|item| item.hwnd))
        });
        if let Some(hwnd) = hwnd {
            let point = unsafe { (*(data.0 as *const MSLLHOOKSTRUCT)).pt };
            let mut bounds = RECT::default();
            if unsafe { GetWindowRect(hwnd, &mut bounds).is_ok() }
                && (point.x < bounds.left
                    || point.x >= bounds.right
                    || point.y < bounds.top
                    || point.y >= bounds.bottom)
            {
                // Post a notification without consuming the original click.
                unsafe {
                    let _ = PostMessageW(Some(hwnd), OUTSIDE_CLICK, WPARAM(0), LPARAM(0));
                }
            }
        }
    }
    unsafe { CallNextHookEx(None, code, message, data) }
}
