import Homey from 'homey';
import {
  CyberQClient,
  CyberQStatus,
  DegUnits,
  fToC,
} from '../../lib/CyberQClient';
import { SessionRecorder } from '../../lib/SessionRecorder';

type Probe = 1 | 2 | 3;

interface DeviceSettings {
  host: string;
  port: number;
  poll_interval: number;
  offline_poll_interval: number;
}

module.exports = class CyberQDevice extends Homey.Device {
  private client!: CyberQClient;
  private pollHandle?: NodeJS.Timeout;
  private controllerUnits: DegUnits = 'F';
  private lastFoodDone: Record<Probe, boolean> = { 1: false, 2: false, 3: false };
  private lastFanOutput = 0;
  private consecutiveFailures = 0;
  private writing = false;

  /** Most recent successful poll — used as baseline for writes. */
  private latestStatus?: CyberQStatus;

  /** Session recorder — manages the lifecycle of a cooking session. */
  private sessionRecorder!: SessionRecorder;

  async onInit(): Promise<void> {
    this.log('>>> CyberQDevice onInit starting <<<');
    await this.migrateCapabilities();

    const settings = this.getSettings() as DeviceSettings;
    this.log(`Settings: ${JSON.stringify(settings)}`);

    this.client = new CyberQClient({
      host: settings.host,
      port: settings.port,
      logger: (msg) => this.log(msg),
    });

    // Session recorder. /userdata is Homey's app-private writable directory,
    // also reachable over HTTPS at https://<homey>/app/<app.id>/userdata/ —
    // handy for grabbing session JSON files from a browser.
    this.sessionRecorder = new SessionRecorder(
      '/userdata',
      {
        get: (k) => this.getStoreValue(k),
        set: async (k, v) => { await this.setStoreValue(k, v); },
        unset: async (k) => { await this.unsetStoreValue(k); },
      },
      (msg) => this.log(msg),
    );
    await this.sessionRecorder.load();
    await this.reflectSessionState();

    this.registerCapabilityListener('target_temperature', async (value: number) => {
      this.log(`<<< CAPABILITY: target_temperature ← ${value}°C >>>`);
      await this.setPitTarget(value);
    });

    for (const i of [1, 2, 3] as Probe[]) {
      this.registerCapabilityListener(`target_temperature.food${i}`, async (value: number) => {
        this.log(`<<< CAPABILITY: target_temperature.food${i} ← ${value}°C >>>`);
        await this.setFoodTarget(i, value);
      });
    }

    await this.startPolling();
    this.log(`>>> CyberQDevice ready: ${settings.host}:${settings.port} <<<`);
  }

  async onSettings({
    newSettings,
    changedKeys,
  }: {
    oldSettings: { [k: string]: any };
    newSettings: { [k: string]: any };
    changedKeys: string[];
  }): Promise<void> {
    if (changedKeys.includes('host') || changedKeys.includes('port')) {
      this.client = new CyberQClient({
        host: String(newSettings.host),
        port: Number(newSettings.port) || 80,
        logger: (msg) => this.log(msg),
      });
    }
    if (changedKeys.includes('poll_interval') || changedKeys.includes('offline_poll_interval')) {
      await this.startPolling();
    }
  }

  async onDeleted(): Promise<void> { this.stopPolling(); }

  /**
   * Reconcile a device's capabilities with the manifest at init time.
   * Safe to run on every boot — additions and removals are no-ops if the
   * capability is already in the desired state.
   */
  private async migrateCapabilities(): Promise<void> {
    // Removed in 0.1.6: single shared food status capability.
    if (this.hasCapability('cyberq_food_status')) {
      this.log('[migrate] removing legacy capability cyberq_food_status');
      await this.removeCapability('cyberq_food_status').catch((e: any) =>
        this.error('removeCapability failed:', e?.message ?? e),
      );
    }
    // Added in 0.1.6: per-probe status.
    for (const i of [1, 2, 3]) {
      const cap = `cyberq_food${i}_status`;
      if (!this.hasCapability(cap)) {
        this.log(`[migrate] adding capability ${cap}`);
        await this.addCapability(cap).catch((e: any) =>
          this.error(`addCapability ${cap} failed:`, e?.message ?? e),
        );
      }
    }
    // Added in 0.2.0: session tracking.
    for (const cap of ['cooking_session_active', 'cooking_session_name']) {
      if (!this.hasCapability(cap)) {
        this.log(`[migrate] adding capability ${cap}`);
        await this.addCapability(cap).catch((e: any) =>
          this.error(`addCapability ${cap} failed:`, e?.message ?? e),
        );
      }
    }
  }

  // ── Polling ──────────────────────────────────────────────────────
  private async startPolling(): Promise<void> {
    this.stopPolling();
    const settings = this.getSettings() as DeviceSettings;
    const onlineMs = (settings.poll_interval ?? 5) * 1000;
    const offlineMs = (settings.offline_poll_interval ?? 60) * 1000;
    const tick = async () => {
      if (!this.writing) {
        try { await this.poll(); }
        catch (e: any) { this.error('Poll failed:', e?.message ?? e); }
      }
      const interval = this.consecutiveFailures >= 3 ? offlineMs : onlineMs;
      this.pollHandle = this.homey.setTimeout(tick, interval);
    };
    this.pollHandle = this.homey.setTimeout(tick, 1000);
  }
  private stopPolling(): void {
    if (this.pollHandle) { this.homey.clearTimeout(this.pollHandle); this.pollHandle = undefined; }
  }

  private async poll(): Promise<void> {
    let status: CyberQStatus;
    try {
      status = await this.client.getStatus();
      this.consecutiveFailures = 0;
      this.latestStatus = status;
      if (!this.getAvailable()) await this.setAvailable();
    } catch (err: any) {
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures === 3) {
        await this.setUnavailable(`CyberQ unreachable: ${err.message}`).catch(() => {});
      }
      return;
    }

    this.controllerUnits = status.degUnits;
    const toC = (v: number) => (this.controllerUnits === 'F' ? fToC(v) : v);

    await this.safeSet('measure_temperature', round1(toC(status.cook.temp)));
    await this.safeSet('target_temperature', round1(toC(status.cook.set)));
    const probes = [
      { i: 1 as Probe, p: status.food1 },
      { i: 2 as Probe, p: status.food2 },
      { i: 3 as Probe, p: status.food3 },
    ];
    for (const { i, p } of probes) {
      await this.safeSet(`measure_temperature.food${i}`, round1(toC(p.temp)));
      await this.safeSet(`target_temperature.food${i}`, round1(toC(p.set)));
      await this.safeSet(`cyberq_food${i}_status`, mapStatus(p.status));
    }
    await this.safeSet('cyberq_fan_output', status.fanOutput);
    await this.safeSet('cyberq_cook_status', mapStatus(status.cook.status));
    await this.safeSet('cyberq_timer_remaining', status.timerCurr || '');
    await this.safeSet('alarm_generic', status.fanShorted);

    // Record sample if a session is active
    if (this.sessionRecorder?.isActive()) {
      this.sessionRecorder.addSample({
        pitTempC:   round1(toC(status.cook.temp)),
        pitSetC:    round1(toC(status.cook.set)),
        food1TempC: round1(toC(status.food1.temp)),
        food1SetC:  round1(toC(status.food1.set)),
        food2TempC: round1(toC(status.food2.temp)),
        food2SetC:  round1(toC(status.food2.set)),
        food3TempC: round1(toC(status.food3.temp)),
        food3SetC:  round1(toC(status.food3.set)),
        fan:        status.fanOutput,
        cookStatus: mapStatus(status.cook.status),
        food1Status: mapStatus(status.food1.status),
        food2Status: mapStatus(status.food2.status),
        food3Status: mapStatus(status.food3.status),
      });
    }

    await this.triggerFlowsForStatus(status);
  }

  private async triggerFlowsForStatus(status: CyberQStatus): Promise<void> {
    const toC = (v: number) => (this.controllerUnits === 'F' ? fToC(v) : v);
    const pitTempC = round1(toC(status.cook.temp));
    const pitSetC = round1(toC(status.cook.set));

    this.homey.flow.getDeviceTriggerCard('pit_temp_changed')
      .trigger(this, { temperature: pitTempC }).catch(this.error);

    if (pitSetC > 0 && pitTempC < pitSetC) {
      const delta = round1(pitSetC - pitTempC);
      this.homey.flow.getDeviceTriggerCard('pit_below_setpoint')
        .trigger(this, { delta, temperature: pitTempC }, { delta }).catch(this.error);
    }
    const probes = [
      { i: 1 as Probe, p: status.food1 },
      { i: 2 as Probe, p: status.food2 },
      { i: 3 as Probe, p: status.food3 },
    ];
    for (const { i, p } of probes) {
      const done = p.status === 'DONE' || p.status === 'HIGH';
      if (done && !this.lastFoodDone[i]) {
        const tempC = round1(toC(p.temp));
        this.homey.flow.getDeviceTriggerCard('food_probe_done')
          .trigger(this, { probe: i, name: p.name || `Food ${i}`, temperature: tempC }, { probe: String(i) })
          .catch(this.error);
      }
      this.lastFoodDone[i] = done;
    }
    if (status.fanOutput !== this.lastFanOutput) {
      this.homey.flow.getDeviceTriggerCard('fan_output_above')
        .trigger(this, { fan: status.fanOutput }, { threshold: status.fanOutput }).catch(this.error);
      this.lastFanOutput = status.fanOutput;
    }
    if (status.fanShorted) {
      this.homey.flow.getDeviceTriggerCard('fan_fault').trigger(this).catch(this.error);
    }
  }

  // ── Writes ──────────────────────────────────────────────────────
  private async withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    this.writing = true;
    this.log('[write] lock acquired (pausing polling)');
    try { return await fn(); }
    finally {
      this.writing = false;
      this.log('[write] lock released');
      this.homey.setTimeout(() => this.poll().catch(() => undefined), 500);
    }
  }

  async setPitTarget(celsius: number): Promise<void> {
    this.log(`[setPitTarget] ${celsius}°C`);
    await this.withWriteLock(async () => {
      const state = await this.buildState({ cookSetC: celsius });
      this.log(`[setPitTarget] submitting state: ${JSON.stringify(state)}`);
      await this.client.submitState(state);
    });
    this.log('[setPitTarget] complete');
  }

  async setFoodTarget(probe: Probe, celsius: number): Promise<void> {
    this.log(`[setFoodTarget] probe=${probe} ${celsius}°C`);
    await this.withWriteLock(async () => {
      const key = `food${probe}SetC` as 'food1SetC' | 'food2SetC' | 'food3SetC';
      const state = await this.buildState({ [key]: celsius } as any);
      this.log(`[setFoodTarget] submitting state: ${JSON.stringify(state)}`);
      await this.client.submitState(state);
    });
    this.log('[setFoodTarget] complete');
  }

  // ── Sessions ────────────────────────────────────────────────────
  async startSession(name: string, note: string): Promise<void> {
    this.log(`[session] start request: name="${name}" note="${note}"`);
    const s = this.latestStatus;
    await this.sessionRecorder.start({
      name,
      note,
      foodNames: s
        ? { food1: s.food1.name, food2: s.food2.name, food3: s.food3.name }
        : undefined,
    });
    await this.reflectSessionState();
    this.homey.flow
      .getDeviceTriggerCard('session_started')
      .trigger(this, { name: this.sessionRecorder.currentName() })
      .catch(this.error);
  }

  async stopSession(): Promise<void> {
    this.log('[session] stop request');
    const summary = await this.sessionRecorder.stop();
    await this.reflectSessionState();
    this.homey.flow
      .getDeviceTriggerCard('session_ended')
      .trigger(this, {
        name: summary.name,
        duration_min: summary.durationMin,
        samples: summary.sampleCount,
        pit_peak: summary.pitPeakC,
        pit_avg: summary.pitAvgC,
        file: summary.filePath,
      })
      .catch(this.error);
  }

  addSessionNote(text: string): void {
    if (!this.sessionRecorder?.isActive()) {
      throw new Error('No active session to add a note to.');
    }
    this.sessionRecorder.addNote(text);
  }

  private async reflectSessionState(): Promise<void> {
    const active = this.sessionRecorder?.isActive() ?? false;
    await this.safeSet('cooking_session_active', active);
    await this.safeSet('cooking_session_name', active ? this.sessionRecorder.currentName() : '');
  }

  /**
   * Build a full state payload using the latest poll snapshot as baseline,
   * with the supplied overrides applied. If we have no cached state yet,
   * fetch one synchronously.
   */
  private async buildState(overrides: Partial<{
    cookSetC: number;
    food1SetC: number;
    food2SetC: number;
    food3SetC: number;
    cookName: string;
    food1Name: string;
    food2Name: string;
    food3Name: string;
  }>): Promise<{
    cookSetC: number;
    food1SetC: number;
    food2SetC: number;
    food3SetC: number;
    cookName: string;
    food1Name: string;
    food2Name: string;
    food3Name: string;
  }> {
    let s = this.latestStatus;
    if (!s) {
      this.log('[buildState] no cached status, fetching live...');
      s = await this.client.getStatus();
      this.latestStatus = s;
    }
    const toC = (v: number) => (s!.degUnits === 'F' ? fToC(v) : v);
    return {
      cookSetC:  overrides.cookSetC  ?? toC(s.cook.set),
      food1SetC: overrides.food1SetC ?? toC(s.food1.set),
      food2SetC: overrides.food2SetC ?? toC(s.food2.set),
      food3SetC: overrides.food3SetC ?? toC(s.food3.set),
      cookName:  overrides.cookName  ?? s.cook.name,
      food1Name: overrides.food1Name ?? s.food1.name,
      food2Name: overrides.food2Name ?? s.food2.name,
      food3Name: overrides.food3Name ?? s.food3.name,
    };
  }

  // ── Condition helpers ──
  isCooking(): boolean {
    const fan = (this.getCapabilityValue('cyberq_fan_output') as number) ?? 0;
    const status = (this.getCapabilityValue('cyberq_cook_status') as string) ?? 'OFF';
    return status !== 'OFF' || fan > 0;
  }
  isPitWithinBand(bandC: number): boolean {
    const temp = this.getCapabilityValue('measure_temperature') as number | null;
    const target = this.getCapabilityValue('target_temperature') as number | null;
    if (temp === null || target === null) return false;
    return Math.abs(temp - target) <= bandC;
  }

  private async safeSet(capability: string, value: any): Promise<void> {
    if (!this.hasCapability(capability)) return;
    if (value === undefined || value === null) return;
    try {
      const current = this.getCapabilityValue(capability);
      if (current === value) return;
      await this.setCapabilityValue(capability, value);
    } catch (err: any) {
      this.error(`setCapabilityValue ${capability} failed:`, err?.message ?? err);
    }
  }
};

function round1(n: number): number { return Math.round(n * 10) / 10; }
const VALID_STATUS = new Set(['OK', 'HIGH', 'LOW', 'DONE', 'ERROR', 'OFF']);
function mapStatus(raw: string): string {
  const u = (raw || '').trim().toUpperCase();
  return VALID_STATUS.has(u) ? u : 'OK';
}
