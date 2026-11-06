use base64::{Engine, engine::general_purpose::STANDARD};
use windows::{
    Win32::{
        Foundation::SIZE,
        Graphics::Gdi::{
            BI_RGB, BITMAP, BITMAPINFO, BITMAPINFOHEADER, CreateCompatibleDC, DIB_RGB_COLORS,
            DeleteDC, DeleteObject, GetDIBits, GetObjectW, HBITMAP, HGDIOBJ,
        },
        System::Com::{CoTaskMemFree, IBindCtx},
        UI::Shell::{
            IShellItem, IShellItemImageFactory, SHCreateItemFromParsingName, SIGDN_FILESYSPATH,
            SIIGBF_ICONONLY,
        },
    },
    core::{Interface, PCWSTR},
};

pub(crate) fn load(item: &IShellItem) -> Option<String> {
    let bytes = item
        .cast::<IShellItemImageFactory>()
        .ok()
        .and_then(icon_png)
        .or_else(|| {
            let factory = unsafe {
                let path = item.GetDisplayName(SIGDN_FILESYSPATH).ok()?;
                let factory = SHCreateItemFromParsingName(PCWSTR(path.0), None::<&IBindCtx>);
                CoTaskMemFree(Some(path.0.cast()));
                factory.ok()?
            };
            icon_png(factory)
        })?;
    Some(format!("data:image/png;base64,{}", STANDARD.encode(bytes)))
}

fn icon_png(factory: IShellItemImageFactory) -> Option<Vec<u8>> {
    let bitmap = unsafe {
        factory
            .GetImage(SIZE { cx: 32, cy: 32 }, SIIGBF_ICONONLY)
            .ok()?
    };
    let png = encode_bitmap(bitmap);
    unsafe {
        let _ = DeleteObject(HGDIOBJ(bitmap.0));
    }
    png
}

fn encode_bitmap(bitmap: HBITMAP) -> Option<Vec<u8>> {
    let mut dimensions = BITMAP::default();
    let read = unsafe {
        GetObjectW(
            HGDIOBJ(bitmap.0),
            size_of::<BITMAP>() as i32,
            Some((&mut dimensions as *mut BITMAP).cast()),
        )
    };
    let (width, height) = (dimensions.bmWidth, dimensions.bmHeight);
    if read == 0 || !(1..=256).contains(&width) || !(1..=256).contains(&height) {
        return None;
    }

    let mut info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: -height,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut pixels = vec![0u8; width as usize * height as usize * 4];
    let dc = unsafe { CreateCompatibleDC(None) };
    if dc.is_invalid() {
        return None;
    }
    let lines = unsafe {
        let lines = GetDIBits(
            dc,
            bitmap,
            0,
            height as u32,
            Some(pixels.as_mut_ptr().cast()),
            &mut info,
            DIB_RGB_COLORS,
        );
        let _ = DeleteDC(dc);
        lines
    };
    if lines != height {
        return None;
    }

    let has_alpha = pixels.chunks_exact(4).any(|pixel| pixel[3] != 0);
    for pixel in pixels.chunks_exact_mut(4) {
        pixel.swap(0, 2);
        if !has_alpha {
            pixel[3] = 255;
        }
    }
    let mut bytes = Vec::new();
    let mut encoder = png::Encoder::new(&mut bytes, width as u32, height as u32);
    encoder.set_color(png::ColorType::Rgba);
    encoder
        .write_header()
        .ok()?
        .write_image_data(&pixels)
        .ok()?;
    Some(bytes)
}
