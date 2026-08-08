#![forbid(unsafe_code)]

use futures_util::{SinkExt, StreamExt};
use leddy_interfaces::{
    DeviceCapabilities, DeviceCommand, DeviceEvent, DeviceTelemetry, DisplayConfig, PixelOrigin,
};
use leddy_lib::{content_width, render_message_frame, scroll_cycle_duration_ms};
use serde_json::json;
use std::{
    env,
    io::{self, Write},
    time::Instant,
};
use tokio_tungstenite::{connect_async, tungstenite::Message};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let url = env::var("LEDDY_DEVICE_WS_URL")
        .unwrap_or_else(|_| "ws://127.0.0.1:18080/v1/ws/devices".into());
    let device_id = env::var("LEDDY_DEVICE_ID").unwrap_or_else(|_| "virtual-e2e".into());
    let max_commands = env::var("LEDDY_VIRTUAL_DEVICE_MAX_COMMANDS")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(usize::MAX);
    let mut config = DisplayConfig {
        width: env_u16("LEDDY_MATRIX_WIDTH", 300),
        height: env_u16("LEDDY_MATRIX_HEIGHT", 20),
        brightness: 96,
        serpentine: true,
        origin: PixelOrigin::TopLeft,
    };
    config.validate()?;

    let started = Instant::now();
    let (socket, _) = connect_async(&url).await?;
    let (mut writer, mut reader) = socket.split();

    let hello = DeviceEvent::Hello {
        device_id: device_id.clone(),
        firmware_version: env!("CARGO_PKG_VERSION").into(),
        capabilities: DeviceCapabilities {
            max_width: config.width,
            max_height: config.height,
            color_depth_bits: 1,
            supports_brightness: true,
        },
    };
    writer
        .send(Message::Text(serde_json::to_string(&hello)?.into()))
        .await?;

    let mut handled = 0_usize;
    while let Some(incoming) = reader.next().await {
        let Message::Text(text) = incoming? else {
            continue;
        };
        let command: DeviceCommand = serde_json::from_str(&text)?;

        match command {
            DeviceCommand::Show(message) => {
                message.validate()?;
                let width = content_width(&message.text);
                let cycle_ms = scroll_cycle_duration_ms(
                    message.speed_pixels_per_second,
                    width,
                    usize::from(config.width),
                )
                .ok_or("message has invalid scroll speed")?;
                let sample_ms = cycle_ms / 2;
                let frame = render_message_frame(&config, &message, sample_ms)?;
                let (frame_pixels, device_pixels, lit_pixels) = match frame {
                    Some(frame) => {
                        let row_major = frame.row_major();
                        let device_order = frame.device_order();
                        (
                            row_major.len(),
                            device_order.len(),
                            row_major.iter().filter(|pixel| **pixel != 0).count(),
                        )
                    }
                    None => (config.pixel_count(), config.pixel_count(), 0),
                };

                emit(json!({
                    "type": "show",
                    "device_id": device_id,
                    "message_id": message.id,
                    "width": config.width,
                    "height": config.height,
                    "content_width": width,
                    "frame_pixels": frame_pixels,
                    "device_pixels": device_pixels,
                    "lit_pixels": lit_pixels,
                    "sample_ms": sample_ms,
                    "cycle_ms": cycle_ms,
                    "direction": message.direction,
                    "repeat": message.repeat,
                }))?;

                send_event(
                    &mut writer,
                    DeviceEvent::Ack {
                        command_id: message.id.clone(),
                    },
                )
                .await?;
                send_telemetry(
                    &mut writer,
                    &device_id,
                    started.elapsed().as_secs(),
                    Some(message.id),
                )
                .await?;
                handled += 1;
            }
            DeviceCommand::Clear => {
                emit(json!({
                    "type": "clear",
                    "device_id": device_id,
                    "width": config.width,
                    "height": config.height,
                }))?;
                send_event(
                    &mut writer,
                    DeviceEvent::Ack {
                        command_id: "clear".into(),
                    },
                )
                .await?;
                send_telemetry(
                    &mut writer,
                    &device_id,
                    started.elapsed().as_secs(),
                    None,
                )
                .await?;
                handled += 1;
            }
            DeviceCommand::Configure(next) => {
                next.validate()?;
                config = next;
                emit(json!({
                    "type": "configure",
                    "device_id": device_id,
                    "width": config.width,
                    "height": config.height,
                    "serpentine": config.serpentine,
                    "origin": config.origin,
                }))?;
                send_event(
                    &mut writer,
                    DeviceEvent::Ack {
                        command_id: "configure".into(),
                    },
                )
                .await?;
                handled += 1;
            }
            DeviceCommand::Ping { nonce } => {
                send_event(&mut writer, DeviceEvent::Pong { nonce }).await?;
            }
        }

        if handled >= max_commands {
            break;
        }
    }

    Ok(())
}

async fn send_telemetry<S>(
    writer: &mut S,
    device_id: &str,
    uptime_seconds: u64,
    current_message_id: Option<String>,
) -> Result<(), Box<dyn std::error::Error>>
where
    S: SinkExt<Message> + Unpin,
    S::Error: std::error::Error + Send + Sync + 'static,
{
    send_event(
        writer,
        DeviceEvent::Telemetry(DeviceTelemetry {
            device_id: device_id.into(),
            uptime_seconds,
            free_memory_bytes: 0,
            temperature_celsius: None,
            wifi_rssi_dbm: None,
            current_message_id,
        }),
    )
    .await
}

async fn send_event<S>(
    writer: &mut S,
    event: DeviceEvent,
) -> Result<(), Box<dyn std::error::Error>>
where
    S: SinkExt<Message> + Unpin,
    S::Error: std::error::Error + Send + Sync + 'static,
{
    writer
        .send(Message::Text(serde_json::to_string(&event)?.into()))
        .await?;
    Ok(())
}

fn emit(value: serde_json::Value) -> io::Result<()> {
    println!("{}", serde_json::to_string(&value).expect("serialize observation"));
    io::stdout().flush()
}

fn env_u16(name: &str, fallback: u16) -> u16 {
    env::var(name)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(fallback)
}
