# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.6] - 2026-05-18

### Added
- Per-probe food status capabilities (`cyberq_food1_status`,
  `cyberq_food2_status`, `cyberq_food3_status`) so each probe shows its own
  state in the Homey UI instead of mirroring FOOD1.
- Automatic capability migration on device init — existing devices upgrade
  in place without re-pairing.

### Removed
- The single shared `cyberq_food_status` capability (replaced by the three
  per-probe variants above).

## [0.1.5] - 2026-05-18

### Fixed
- Writes hung indefinitely against the device. Root cause: Node's built-in
  `fetch` (undici) sends HTTP/1.1 features the CyberQ's firmware can't
  handle (likely chunked encoding or keep-alive pooling). Replaced fetch
  with `node:http`'s `http.request` for writes, with explicit
  `Content-Length`, `Connection: close`, and `agent: false`. Reads
  continue to use fetch (works fine).

## [0.1.4] - 2026-05-18

### Fixed
- Partial form submissions caused the device to hang waiting for missing
  fields. Now caches the latest poll snapshot and submits the full form
  state (all setpoints + names + timer) on every write, with the new
  value overridden — matching how the device's own web form posts.

## [0.1.3] - 2026-05-18

### Fixed
- Discovered the device's wire format from a browser POST capture:
  - Form body must be wrapped between `EEAUTOFLUSH=0` and `EEAUTOFLUSH=1`
    sentinels; the firmware only persists changes when it sees the
    closing flush marker.
  - Temperatures are sent as whole degrees, not tenths.
  - Both Fahrenheit (`FIELD`) and Celsius (`_FIELD`) values are submitted
    for every setpoint.

## [0.1.2] - 2026-05-18

### Added
- Build version banner logged at app boot (`build=...`), making it
  unambiguous whether new code is actually running.
- Debug-level setting `write_method` to switch between POST-with-prefix,
  POST-without-prefix, and GET while diagnosing write failures.
- Verbose logging at every step of the write path.

## [0.1.1] - 2026-05-18

### Fixed
- Pairing flow showed an empty window because `add_devices` template was
  invoked without a preceding `list_devices` step. Added the missing
  `list_devices` template, which calls the driver's handler and runs the
  live connection test.

## [0.1.0] - 2026-05-18

### Added
- Initial Homey App SDK v3 project scaffold for the BBQ Guru CyberQ WiFi
  controller.
- `CyberQClient`: HTTP client that fetches `/all.xml` and parses status
  into typed structures.
- `cyberq` driver and device with capabilities:
  - `measure_temperature` and `target_temperature` for the pit
  - Three food probes (`measure_temperature.foodN`,
    `target_temperature.foodN`)
  - Custom `cyberq_fan_output`, `cyberq_cook_status`,
    `cyberq_food_status`, `cyberq_timer_remaining`
  - `alarm_generic` for fan-shorted alarm
- Polling loop (5s default, slows to 60s after repeated failures).
- Automatic unit conversion between the device's configured `DEG_UNITS`
  and Homey's Celsius internal model.
- Flow triggers: pit temperature changed, pit dropped below setpoint by
  delta, food probe done, fan output above threshold, fan fault.
- Flow conditions: is cooking, pit within band of setpoint.
- Flow actions: set pit temperature, set food temperature per probe.
- Custom pairing view for entering the device's IP and port.
- Read-only Connection: close header and per-call timeouts.
