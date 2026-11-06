use base64::{Engine, engine::general_purpose::STANDARD};
use windows::{
    Media::Control::GlobalSystemMediaTransportControlsSessionMediaProperties as Properties,
    Storage::Streams::DataReader, core::Result,
};

pub(crate) fn cover(properties: &Properties) -> Result<Option<String>> {
    let stream = properties.Thumbnail()?.OpenReadAsync()?.join()?;
    let size = stream.Size()?;
    if size == 0 || size > 4 * 1024 * 1024 {
        return Ok(None);
    }

    let reader = DataReader::CreateDataReader(&stream.GetInputStreamAt(0)?)?;
    let count = reader.LoadAsync(size as u32)?.join()?;
    if u64::from(count) != size {
        return Ok(None);
    }
    let mut bytes = vec![0; count as usize];
    reader.ReadBytes(&mut bytes)?;
    let mime = match bytes.as_slice() {
        [0xff, 0xd8, 0xff, ..] => "image/jpeg",
        b if b.starts_with(b"\x89PNG\r\n\x1a\n") => "image/png",
        b if b.starts_with(b"RIFF") && b.get(8..12) == Some(b"WEBP") => "image/webp",
        _ => return Ok(None),
    };
    Ok(Some(format!(
        "data:{mime};base64,{}",
        STANDARD.encode(bytes)
    )))
}
