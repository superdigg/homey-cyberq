import * as http from 'http';
import { XMLParser } from 'fast-xml-parser';

/**
 * BBQ Guru CyberQ WiFi client.
 *
 * The CyberQ firmware's HTTP stack is fragile. Node's fetch (undici) seems to
 * tickle it the wrong way — POSTs hang indefinitely. curl with the exact same
 * body works fine. So for writes we drop down to Node's raw http.request,
 * which lets us match curl's wire behaviour: explicit Content-Length, no
 * keep-alive pooling, no chunked encoding, no Expect: 100-continue, etc.
 */

export type DegUnits = 'F' | 'C';

export interface ProbeReading {
  temp: number;
  set: number;
  name: string;
  status: string;
}

export interface CyberQStatus {
  cook: ProbeReading;
  food1: ProbeReading;
  food2: ProbeReading;
  food3: ProbeReading;
  fanOutput: number;
  fanShorted: boolean;
  degUnits: DegUnits;
  timerCurr: string;
  timerStatus: string;
  cookStatus: string;
  raw: any;
}

export type Logger = (msg: string) => void;

export interface CyberQClientOptions {
  host: string;
  port?: number;
  getTimeoutMs?: number;
  postTimeoutMs?: number;
  username?: string;
  password?: string;
  logger?: Logger;
}

export class CyberQClient {
  private host: string;
  private port: number;
  private getTimeoutMs: number;
  private postTimeoutMs: number;
  private authHeader?: string;
  private log: Logger;
  private parser = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: true,
    trimValues: true,
  });

  constructor(opts: CyberQClientOptions) {
    this.host = opts.host;
    this.port = opts.port ?? 80;
    this.getTimeoutMs = opts.getTimeoutMs ?? 4000;
    this.postTimeoutMs = opts.postTimeoutMs ?? 15000;
    this.log = opts.logger ?? (() => undefined);
    if (opts.username && opts.password) {
      const b64 = Buffer.from(`${opts.username}:${opts.password}`).toString('base64');
      this.authHeader = `Basic ${b64}`;
    }
  }

  // ── GET /all.xml via fetch (works fine for reads) ─────────────────
  async getStatus(): Promise<CyberQStatus> {
    const url = `http://${this.host}:${this.port}/all.xml`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.getTimeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        signal: ctrl.signal,
        headers: { Accept: 'application/xml,text/xml' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    } finally {
      clearTimeout(timer);
    }
    const xml = await res.text();
    const parsed = this.parser.parse(xml);
    const root = parsed?.nutcallstatus;
    if (!root) throw new Error('Unexpected XML payload: missing <nutcallstatus>');

    const numOrZero = (v: any): number => {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    };
    const tenth = (v: any): number => numOrZero(v) / 10;
    const str = (v: any): string => (v === undefined || v === null ? '' : String(v));
    const degUnits: DegUnits = String(root.DEG_UNITS).toUpperCase().startsWith('C') ? 'C' : 'F';
    const probe = (
      node: any,
      keys: { temp: string; set: string; name: string; status: string },
    ): ProbeReading => ({
      temp: tenth(node?.[keys.temp]),
      set: tenth(node?.[keys.set]),
      name: str(node?.[keys.name]),
      status: str(node?.[keys.status]),
    });

    return {
      cook:  probe(root.COOK,  { temp: 'COOK_TEMP',  set: 'COOK_SET',  name: 'COOK_NAME',  status: 'COOK_STATUS'  }),
      food1: probe(root.FOOD1, { temp: 'FOOD1_TEMP', set: 'FOOD1_SET', name: 'FOOD1_NAME', status: 'FOOD1_STATUS' }),
      food2: probe(root.FOOD2, { temp: 'FOOD2_TEMP', set: 'FOOD2_SET', name: 'FOOD2_NAME', status: 'FOOD2_STATUS' }),
      food3: probe(root.FOOD3, { temp: 'FOOD3_TEMP', set: 'FOOD3_SET', name: 'FOOD3_NAME', status: 'FOOD3_STATUS' }),
      fanOutput:   numOrZero(root.OUTPUT_PERCENT),
      fanShorted:  String(root.FAN_SHORTED) === '1' || String(root.FAN_SHORTED).toUpperCase() === 'TRUE',
      degUnits,
      timerCurr:   str(root.TIMER_CURR),
      timerStatus: str(root.TIMER_STATUS),
      cookStatus:  str(root.COOK?.COOK_STATUS),
      raw: parsed,
    };
  }

  async submitState(state: {
    cookSetC: number;
    food1SetC: number;
    food2SetC: number;
    food3SetC: number;
    cookName: string;
    food1Name: string;
    food2Name: string;
    food3Name: string;
  }): Promise<void> {
    const fInt = (c: number) => String(Math.round(c * (9 / 5) + 32));
    const cInt = (c: number) => String(Math.round(c));

    // Build body in exactly the order the device's web form posts.
    const parts: string[] = [];
    parts.push('EEAUTOFLUSH=0');
    parts.push(`COOK_SET=${fInt(state.cookSetC)}`);
    parts.push(`FOOD1_SET=${fInt(state.food1SetC)}`);
    parts.push(`FOOD2_SET=${fInt(state.food2SetC)}`);
    parts.push(`FOOD3_SET=${fInt(state.food3SetC)}`);
    parts.push(`COOK_NAME=${encodeURIComponent(state.cookName)}`);
    parts.push(`_COOK_SET=${cInt(state.cookSetC)}`);
    parts.push(`FOOD1_NAME=${encodeURIComponent(state.food1Name)}`);
    parts.push(`_FOOD1_SET=${cInt(state.food1SetC)}`);
    parts.push(`FOOD2_NAME=${encodeURIComponent(state.food2Name)}`);
    parts.push(`_FOOD2_SET=${cInt(state.food2SetC)}`);
    parts.push(`FOOD3_NAME=${encodeURIComponent(state.food3Name)}`);
    parts.push(`_FOOD3_SET=${cInt(state.food3SetC)}`);
    parts.push('_COOK_TIMER=');
    parts.push('EEAUTOFLUSH=1');
    const body = parts.join('&');
    await this.rawPost('/', body);
  }

  /**
   * Low-level POST using node:http directly. We pick this over fetch because
   * undici's HTTP/1.1 behaviour (chunked, keep-alive pooling, Expect headers,
   * etc.) seems to wedge the CyberQ's firmware. http.request lets us mirror
   * curl's wire format exactly.
   */
  private rawPost(path: string, body: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const buf = Buffer.from(body, 'utf8');
      const headers: Record<string, string> = {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': String(buf.length),
        'Connection': 'close',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'User-Agent': 'Mozilla/5.0 (compatible; Homey-CyberQ/0.1)',
        'Origin': `http://${this.host}:${this.port}`,
        'Referer': `http://${this.host}:${this.port}/`,
      };
      if (this.authHeader) headers['Authorization'] = this.authHeader;

      this.log(`[client] HTTP POST http://${this.host}:${this.port}${path}  body=${body}`);
      const started = Date.now();

      const req = http.request(
        {
          host: this.host,
          port: this.port,
          path,
          method: 'POST',
          headers,
          agent: false, // no connection pooling
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const elapsed = Date.now() - started;
            const body = Buffer.concat(chunks).toString('utf8');
            this.log(`[client] HTTP done in ${elapsed}ms status=${res.statusCode} bodyLen=${body.length}`);
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 400) {
              resolve();
            } else {
              reject(new Error(`HTTP ${res.statusCode}`));
            }
          });
          res.on('error', (err) => reject(err));
        },
      );

      req.setTimeout(this.postTimeoutMs, () => {
        const elapsed = Date.now() - started;
        this.log(`[client] HTTP timeout after ${elapsed}ms — destroying socket`);
        req.destroy(new Error(`POST timeout after ${this.postTimeoutMs}ms`));
      });

      req.on('error', (err: any) => {
        const elapsed = Date.now() - started;
        this.log(`[client] HTTP error after ${elapsed}ms: ${err.message}`);
        reject(err);
      });

      req.write(buf);
      req.end();
    });
  }
}

export function fToC(f: number): number { return (f - 32) * (5 / 9); }
export function cToF(c: number): number { return c * (9 / 5) + 32; }
