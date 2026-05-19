import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Records temperature/fan data for a single BBQ cooking session.
 *
 * Lifecycle:
 *   recorder = new SessionRecorder(homeyUserDataDir, logger)
 *   await recorder.load()                  // restore in-progress session on app boot
 *   await recorder.start({ name, note })   // begin recording
 *   recorder.addSample({ ... })            // called every poll while active
 *   recorder.addNote("more charcoal")      // optional, anytime during a session
 *   const summary = await recorder.stop()  // writes the final file
 *
 * Data is persisted in two places:
 *   - homey.settings ('active_session') — restored on boot if app crashes mid-cook
 *   - /userdata/sessions/<filename>.json — final file written on stop()
 *   - /userdata/sessions/index.json — list of all sessions for quick listing
 */

export interface SessionSample {
  /** Seconds since session start. */
  t: number;
  pitTempC: number;
  pitSetC: number;
  food1TempC: number;
  food1SetC: number;
  food2TempC: number;
  food2SetC: number;
  food3TempC: number;
  food3SetC: number;
  fan: number;
  cookStatus: string;
  food1Status: string;
  food2Status: string;
  food3Status: string;
}

export interface SessionNote {
  /** Seconds since session start. */
  t: number;
  text: string;
}

export interface SessionData {
  name: string;
  startedAt: number;     // unix ms
  endedAt?: number;
  initialNote: string;
  notes: SessionNote[];
  samples: SessionSample[];
  food1Name: string;
  food2Name: string;
  food3Name: string;
}

export interface SessionSummary {
  name: string;
  startedAt: number;
  endedAt: number;
  durationMin: number;
  sampleCount: number;
  pitPeakC: number;
  pitMinC: number;
  pitAvgC: number;
  filePath: string;
}

export interface SessionIndexEntry {
  name: string;
  startedAt: number;
  endedAt: number;
  durationMin: number;
  filename: string;
}

export type SettingsStore = {
  get(key: string): any;
  set(key: string, value: any): Promise<void> | void;
  unset(key: string): Promise<void> | void;
};

export type Logger = (msg: string) => void;

const SETTINGS_KEY = 'active_session';
const SESSIONS_DIR = 'sessions';
const INDEX_FILENAME = 'index.json';
/** Persist active session to homey.settings at most every N ms. */
const PERSIST_INTERVAL_MS = 60_000;

export class SessionRecorder {
  private active: SessionData | null = null;
  private lastPersistedAt = 0;

  constructor(
    private userDataDir: string,
    private settings: SettingsStore,
    private log: Logger = () => undefined,
  ) {}

  isActive(): boolean { return this.active !== null; }
  currentName(): string { return this.active?.name ?? ''; }

  /** Restore an in-progress session from settings, if any. */
  async load(): Promise<void> {
    const raw = this.settings.get(SETTINGS_KEY);
    if (raw && typeof raw === 'object' && raw.startedAt) {
      this.active = raw as SessionData;
      this.log(`[session] restored in-progress: "${this.active.name}" (${this.active.samples.length} samples)`);
    }
  }

  async start(opts: {
    name: string;
    note?: string;
    foodNames?: { food1: string; food2: string; food3: string };
  }): Promise<void> {
    if (this.active) {
      throw new Error(`A session is already running: "${this.active.name}". Stop it first.`);
    }
    const cleanName = (opts.name || '').trim() || `Cook ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
    this.active = {
      name: cleanName,
      startedAt: Date.now(),
      initialNote: (opts.note ?? '').trim(),
      notes: [],
      samples: [],
      food1Name: opts.foodNames?.food1 ?? '',
      food2Name: opts.foodNames?.food2 ?? '',
      food3Name: opts.foodNames?.food3 ?? '',
    };
    await this.persist(true);
    this.log(`[session] started: "${cleanName}"`);
  }

  addSample(sample: Omit<SessionSample, 't'>): void {
    if (!this.active) return;
    const t = Math.round((Date.now() - this.active.startedAt) / 1000);
    this.active.samples.push({ t, ...sample });
    // Persist periodically — too often hurts EEPROM-ish stores; too rarely loses data.
    if (Date.now() - this.lastPersistedAt > PERSIST_INTERVAL_MS) {
      this.persist(false).catch((e) => this.log(`[session] persist failed: ${e.message}`));
    }
  }

  addNote(text: string): void {
    if (!this.active) return;
    const clean = (text || '').trim();
    if (!clean) return;
    const t = Math.round((Date.now() - this.active.startedAt) / 1000);
    this.active.notes.push({ t, text: clean });
    this.persist(true).catch((e) => this.log(`[session] persist failed: ${e.message}`));
    this.log(`[session] note added: "${clean}"`);
  }

  /** Finalise the session: write file, update index, return summary. */
  async stop(): Promise<SessionSummary> {
    if (!this.active) throw new Error('No active session to stop.');
    const s = this.active;
    s.endedAt = Date.now();

    // Aggregate stats
    const pits = s.samples.map((x) => x.pitTempC).filter((v) => v > 0);
    const pitPeak = pits.length ? Math.max(...pits) : 0;
    const pitMin  = pits.length ? Math.min(...pits) : 0;
    const pitAvg  = pits.length ? pits.reduce((a, b) => a + b, 0) / pits.length : 0;
    const durationMin = (s.endedAt - s.startedAt) / 60_000;

    const filename = this.makeFilename(s);
    const filePath = path.join(this.userDataDir, SESSIONS_DIR, filename);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(s, null, 2), 'utf8');

    // Append to index
    await this.appendToIndex({
      name: s.name,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      durationMin: Math.round(durationMin * 10) / 10,
      filename,
    });

    await this.settings.unset(SETTINGS_KEY);
    this.active = null;
    this.log(`[session] stopped, wrote ${filePath} (${s.samples.length} samples)`);

    return {
      name: s.name,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      durationMin: Math.round(durationMin * 10) / 10,
      sampleCount: s.samples.length,
      pitPeakC: Math.round(pitPeak * 10) / 10,
      pitMinC: Math.round(pitMin * 10) / 10,
      pitAvgC: Math.round(pitAvg * 10) / 10,
      filePath,
    };
  }

  /** Read past sessions from the index. */
  async listSessions(): Promise<SessionIndexEntry[]> {
    const indexPath = path.join(this.userDataDir, SESSIONS_DIR, INDEX_FILENAME);
    try {
      const raw = await fs.readFile(indexPath, 'utf8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  // ── internals ─────────────────────────────────────────────────────
  private async persist(force: boolean): Promise<void> {
    if (!this.active) return;
    if (!force && Date.now() - this.lastPersistedAt < PERSIST_INTERVAL_MS) return;
    await this.settings.set(SETTINGS_KEY, this.active);
    this.lastPersistedAt = Date.now();
  }

  private async appendToIndex(entry: SessionIndexEntry): Promise<void> {
    const indexPath = path.join(this.userDataDir, SESSIONS_DIR, INDEX_FILENAME);
    let list: SessionIndexEntry[] = [];
    try {
      const raw = await fs.readFile(indexPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) list = parsed;
    } catch { /* file may not exist yet */ }
    list.push(entry);
    await fs.writeFile(indexPath, JSON.stringify(list, null, 2), 'utf8');
  }

  private makeFilename(s: SessionData): string {
    const d = new Date(s.startedAt);
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
    const slug = s.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'session';
    return `${stamp}_${slug}.json`;
  }
}

function pad(n: number): string { return n < 10 ? `0${n}` : String(n); }
