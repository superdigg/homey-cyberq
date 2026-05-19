import Homey from 'homey';

const APP_BUILD = '0.2.0-sessions';
const APP_BUILD_TS = new Date().toISOString();

module.exports = class CyberQApp extends Homey.App {
  async onInit() {
    this.log('═══════════════════════════════════════════════');
    this.log(`  BBQ Guru CyberQ  build=${APP_BUILD}`);
    this.log(`  Booted at ${APP_BUILD_TS}`);
    this.log('═══════════════════════════════════════════════');

    // Device-bound triggers (referenced so they're discoverable)
    this.homey.flow.getDeviceTriggerCard('pit_temp_changed');
    this.homey.flow.getDeviceTriggerCard('pit_below_setpoint');
    this.homey.flow.getDeviceTriggerCard('food_probe_done');
    this.homey.flow.getDeviceTriggerCard('fan_output_above');
    this.homey.flow.getDeviceTriggerCard('fan_fault');
    this.homey.flow.getDeviceTriggerCard('session_started');
    this.homey.flow.getDeviceTriggerCard('session_ended');

    // Condition cards
    this.homey.flow
      .getConditionCard('is_cooking')
      .registerRunListener(async (args) => (args.device as any).isCooking());

    this.homey.flow
      .getConditionCard('pit_within_band')
      .registerRunListener(async (args) =>
        (args.device as any).isPitWithinBand(Number(args.band)),
      );

    // Action cards — temperature
    this.homey.flow
      .getActionCard('set_pit_temperature')
      .registerRunListener(async (args) =>
        (args.device as any).setPitTarget(Number(args.temperature)),
      );

    this.homey.flow
      .getActionCard('set_food_temperature')
      .registerRunListener(async (args) =>
        (args.device as any).setFoodTarget(Number(args.probe), Number(args.temperature)),
      );

    // Action cards — sessions
    this.homey.flow
      .getActionCard('start_session')
      .registerRunListener(async (args) =>
        (args.device as any).startSession(String(args.name ?? ''), String(args.note ?? '')),
      );

    this.homey.flow
      .getActionCard('stop_session')
      .registerRunListener(async (args) =>
        (args.device as any).stopSession(),
      );

    this.homey.flow
      .getActionCard('add_session_note')
      .registerRunListener(async (args) =>
        (args.device as any).addSessionNote(String(args.note ?? '')),
      );

    this.log('App onInit complete');
  }
};
