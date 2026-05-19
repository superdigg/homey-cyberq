# BBQ Guru CyberQ for Homey

Integrasjon for BBQ Guru CyberQ WiFi-temperaturkontrolleren.

## Hva er dette?

En Homey-app som snakker direkte med CyberQ-ens innebygde webserver (`/all.xml` for status, `POST /` for å sette verdier). Ingen sky, ingen mellomledd — bare LAN.

## Hva støttes

- Pit-temp og målsetpunkt (les + skriv)
- Tre mat-prober med navn, temp og målsetpunkt (les + skriv)
- Vifteutgang (%)
- Cook/food status, timer, viftefeil-alarm
- Flow triggers: pit endret, pit falt under setpunkt, probe ferdig, vifte over %, viftefeil
- Flow conditions: BBQ i gang, pit innenfor X°C av målet
- Flow actions: sett pit-temp, sett probe-temp

## Kom i gang

```bash
# Førstegangs oppsett
npm install
npm install -g homey

# Logg inn mot Homey
homey login

# Bygg + kjør lokalt på Homey-en din
npm run build
homey app run
```

`homey app run` lar appen kjøre på Homeyen din mens du iterer. Logger streames til terminalen. `Ctrl-C` for å stoppe.

## Pairing

1. Finn IP-en til CyberQ-en (vises på enhetens skjerm i WiFi-oppsett).
2. Reserver IP-en i ruteren din (DHCP static lease).
3. Legg til CyberQ-enheten i Homey-appen → skriv inn IP.

## Kjente løse tråder du bør verifisere

1. **POST-feltnavn**: Konstanten `POST_FIELD_PREFIX` i `lib/CyberQClient.ts` er satt til `'_'` (typisk for nyere firmware). Hvis writes ikke virker, åpne `http://<cyberq-ip>/` i en nettleser, sett en verdi via skjemaet, fang POSTen i devtools Network-tab og sjekk om feltene heter `COOK_SET` eller `_COOK_SET`. Sett `POST_FIELD_PREFIX = ''` ved behov.
2. **DEG_UNITS**: Homey jobber i Celsius. Appen leser `DEG_UNITS` ved hver poll og konverterer. Verifiser at temperaturer ser riktige ut etter første cook.
3. **target_temperature-range**: Default er 50–230°C for pit og 20–110°C for mat-prober. Juster i `app.json` om du vil ha annet.
4. **Foodstatus-capability**: I skjelettet speiler den FOOD1 — bygg ut til tre separate enums hvis du vil se hver probe i UI.

## Mappestruktur

```
.
├── app.json                          ← manifest (capabilities, flow, drivers)
├── app.ts                            ← app entrypoint, flow runtime listeners
├── lib/CyberQClient.ts               ← HTTP+XML klient (testbar uten Homey)
├── drivers/cyberq/
│   ├── driver.ts                     ← parring
│   ├── device.ts                     ← polleløkke, triggers, capability listeners
│   └── pair/configure.html           ← IP-inntastingsdialog
└── assets/                           ← appikoner
```
