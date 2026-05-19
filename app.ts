import Homey from 'homey';

const APP_BUILD = '0.1.6-perprobe';
const APP_BUILD_TS = new Date().toISOString();

module.exports = class CyberQApp extends Homey.App {
  async onInit() {
    this.log('═══════════════════════════════════════════════');
    this.log(`  BBQ Guru CyberQ  build=${APP_BUILD}`);
    this.log(`  Booted at ${APP_BUILD_TS}`);
    this.log('═══════════════════════════════════════════════');

    // Device-bound triggers (we just need to reference them for token typing).
    this.homey.flow.getDeviceTriggerCard('pit_temp_changed');
    this.homey.flow.getDeviceTriggerCard('pit_below_setpoint');
    this.homey.flow.getDeviceTriggerCard('food_probe_done');
    this.homey.flow.getDeviceTriggerCard('fan_output_above');
    this.homey.flow.getDeviceTriggerCard('fan_fault');
    this.log('Flow triggers ready');

    // Condition cards
    this.homey.flow
      .getConditionCard('is_cooking')
      .registerRunListener(async (args) => {
        this.log('[flow.cond] is_cooking');
        return (args.device as any).isCooking();
      });

    this.homey.flow
      .getConditionCard('pit_within_band')
      .registerRunListener(async (args) => {
        this.log(`[flow.cond] pit_within_band band=${args.band}`);
        return (args.device as any).isPitWithinBand(Number(args.band));
      });
    this.log('Flow conditions ready');

    // Action cards
    this.homey.flow
      .getActionCard('set_pit_temperature')
      .registerRunListener(async (args) => {
        this.log(`[flow.action] set_pit_temperature temperature=${args.temperature}`);
        try {
          await (args.device as any).setPitTarget(Number(args.temperature));
          this.log('[flow.action] set_pit_temperature: OK');
        } catch (err: any) {
          this.error('[flow.action] set_pit_temperature FAILED:', err?.stack ?? err);
          throw err;
        }
      });

    this.homey.flow
      .getActionCard('set_food_temperature')
      .registerRunListener(async (args) => {
        this.log(`[flow.action] set_food_temperature probe=${args.probe} temperature=${args.temperature}`);
        try {
          await (args.device as any).setFoodTarget(Number(args.probe), Number(args.temperature));
          this.log('[flow.action] set_food_temperature: OK');
        } catch (err: any) {
          this.error('[flow.action] set_food_temperature FAILED:', err?.stack ?? err);
          throw err;
        }
      });
    this.log('Flow actions ready');

    this.log('App onInit complete');
  }
};
