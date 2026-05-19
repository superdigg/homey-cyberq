# Homey CyberQ

A [Homey](https://homey.app) App SDK v3 integration for the BBQ Guru CyberQ
WiFi temperature controller, talking directly to the device's built-in web
server over your local network. No cloud, no middleman.

## Features

- Live pit temperature and setpoint (read + write)
- Three food probes with names, current temp, and target (read + write)
- Fan output (%), timer, cook/food status, fan-fault alarm
- Flow triggers: pit changed, pit below setpoint, probe reached target,
  fan over threshold, fan fault
- Flow conditions: BBQ is cooking, pit within band of setpoint
- Flow actions: set pit temperature, set food probe target
- Automatic unit handling — Homey is always Celsius, the device can be in
  either F or C and is reconciled on every poll

## Installation

This app is not (yet) published to the Homey App Store. Install it locally
via the Homey CLI:

```bash
git clone git@github.com:<your-username>/homey-cyberq.git
cd homey-cyberq
npm install
npm install -g homey   # if you don't have the CLI
homey login
homey app install      # permanent install on your Homey
```

For development (live logs in your terminal, hot reload on changes):

```bash
homey app run
```

## Pairing

1. Find your CyberQ's IP address from the device's WiFi setup screen.
2. Reserve that IP in your router's DHCP settings (static lease) so it
   doesn't move around.
3. In the Homey app: add device → BBQ Guru CyberQ → enter IP.

## Technical notes

The CyberQ firmware's HTTP stack has a few quirks that took some digging
to figure out. Documented here so the next person doesn't have to repeat
the journey.

**Reading state.** `GET /all.xml` returns the full state as XML.
Temperatures are integers in tenths of the unit configured in `DEG_UNITS`
(F or C). Probe data lives under `<COOK>`, `<FOOD1>`, `<FOOD2>`, `<FOOD3>`
with consistent field names (`*_TEMP`, `*_SET`, `*_NAME`, `*_STATUS`).

**Writing state.** Three subtleties the device's web form revealed:

1. **EEAUTOFLUSH wrapping is required.** The body must start with
   `EEAUTOFLUSH=0` and end with `EEAUTOFLUSH=1`. The firmware only
   persists changes to EEPROM when it sees the closing marker. Without
   it, the request hangs forever.
2. **Submit the full form, not a delta.** Partial submissions wedge the
   request parser. This app caches the latest poll snapshot and submits
   all setpoints + names with the new value overridden.
3. **Use raw `http.request`, not `fetch`.** Node's built-in fetch
   (undici) sends HTTP/1.1 features the device's webserver can't cope
   with (probably chunked encoding or keep-alive pooling). Using
   `node:http` directly, with explicit `Content-Length`,
   `Connection: close`, and `agent: false`, mirrors what curl does and
   works reliably.

**Unit handling.** Setpoint writes include both the Fahrenheit value
(`COOK_SET=248`) and the Celsius value (`_COOK_SET=120`) for every
field. The firmware uses whichever matches its current `DEG_UNITS`
setting. Homey's internal model is always Celsius; conversion happens
at the wire boundary.

## Project structure

```
.
├── app.json                     manifest — capabilities, flow, driver, settings
├── app.ts                       app entry — flow listener registration
├── lib/CyberQClient.ts          HTTP client, testable without Homey
├── drivers/cyberq/
│   ├── driver.ts                pairing logic
│   ├── device.ts                poll loop, capability listeners, flow triggers
│   └── pair/configure.html      IP entry dialog
├── assets/                      app icons
├── CHANGELOG.md
└── LICENSE
```

## Tested against

- Homey Pro (2023)
- CyberQ WiFi firmware (older — exact version unknown; web UI on port
  configurable by the user)

The CyberQ WiFi has been discontinued by BBQ Guru. This app targets the
on-device web server, so it should keep working as long as the hardware
lives.

## Contributing

Issues and PRs welcome. The hard part — figuring out the wire protocol —
is done. Room for improvement: mDNS discovery, ramp mode toggle,
configurable poll intervals per cook session, etc.

## License

[MIT](LICENSE) — Thomas, 2026.
