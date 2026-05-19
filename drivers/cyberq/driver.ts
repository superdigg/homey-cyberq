import Homey from 'homey';
import type { PairSession } from 'homey/lib/Driver';
import { CyberQClient } from '../../lib/CyberQClient';

interface ConfigureData {
  host: string;
  port: number;
}

module.exports = class CyberQDriver extends Homey.Driver {
  async onInit(): Promise<void> {
    this.log('CyberQ driver initialised');
  }

  async onPair(session: PairSession): Promise<void> {
    let pending: ConfigureData = { host: '', port: 80 };

    // Debug: log every view transition so we can see the pair state in homey app run
    session.setHandler('showView', async (viewId: string) => {
      this.log(`[pair] showing view: ${viewId}`);
    });

    // Custom "configure" view emits this with the user's IP/port.
    session.setHandler('configure', async (data: ConfigureData) => {
      const host = (data?.host ?? '').trim();
      const port = Number(data?.port) || 80;
      this.log(`[pair] received configure: host=${host} port=${port}`);
      if (!host) throw new Error('IP address is required');
      pending = { host, port };
      return true;
    });

    // The "list_devices" template auto-calls this handler when it loads.
    // We do the actual connection test here and return one device for the
    // user to confirm.
    session.setHandler('list_devices', async () => {
      this.log(`[pair] list_devices: testing ${pending.host}:${pending.port}`);
      if (!pending.host) {
        throw new Error('No IP was provided');
      }
      const client = new CyberQClient({ host: pending.host, port: pending.port });
      try {
        const status = await client.getStatus();
        const id = `cyberq-${pending.host.replace(/\./g, '-')}`;
        this.log(`[pair] CyberQ reachable. Cook name: "${status.cook?.name}" units: ${status.degUnits}`);
        return [
          {
            name: status.cook?.name?.trim() || `CyberQ (${pending.host})`,
            data: { id },
            settings: {
              host: pending.host,
              port: pending.port,
              poll_interval: 5,
              offline_poll_interval: 60,
            },
          },
        ];
      } catch (err: any) {
        this.error(`[pair] connection test failed: ${err.message}`);
        throw new Error(
          `Could not reach CyberQ at ${pending.host}:${pending.port} — ${err.message}`,
        );
      }
    });
  }
};
