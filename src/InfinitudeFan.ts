import { Service, Characteristic, CharacteristicValue, PlatformAccessory } from 'homebridge';
import { InfinitudeClient } from './InfinitudeClient';
import { InfinitudeLog } from './InfinitudeLog';
import { ThermostatConfig } from './types';

type Hap = { Service: typeof Service; Characteristic: typeof Characteristic };

// Infinitude fan speed values
type FanSpeed = 'off' | 'low' | 'med' | 'high' | 'auto';

/**
 * Fan accessory (HomeKit Fanv2) for a single zone.
 *
 * Read characteristics:
 *   - Active           — is the blower physically running?
 *   - CurrentFanState  — idle or blowing
 *   - TargetFanState   — auto vs manual
 *   - RotationSpeed    — current speed as percentage (0/33/66/100)
 *
 * Write characteristics:
 *   - TargetFanState   — toggle auto vs manual hold
 *   - RotationSpeed    — set fan speed (maps % → off/low/med/high)
 *
 * API: /api/{zoneId}/activity/{activity}?fan={off|low|med|high}
 */
export class InfinitudeFan {
  private readonly C: typeof Characteristic;

  constructor(
    private readonly name: string,
    private readonly zoneId: string,
    private readonly client: InfinitudeClient,
    private readonly log: InfinitudeLog,
    private readonly config: ThermostatConfig,
    private readonly accessory: PlatformAccessory,
    private readonly hap: Hap,
  ) {
    this.C = hap.Characteristic;
    this.bindInformation();
    this.registerHandlers();
  }

  // ─── AccessoryInformation ────────────────────────────────────────────────────

  private bindInformation(): void {
    const svc = this.accessory.getService(this.hap.Service.AccessoryInformation);
    if (!svc || !this.config.advancedDetails) return;
    const { manufacturer, model, serial } = this.config.advancedDetails;
    svc
      .setCharacteristic(this.C.Manufacturer, manufacturer ?? 'Carrier')
      .setCharacteristic(this.C.Model, model ?? 'Infinity Touch')
      .setCharacteristic(this.C.SerialNumber, `${serial ?? 'N/A'}-f`);
  }

  // ─── Characteristic registration ─────────────────────────────────────────────

  private registerHandlers(): void {
    const svc = this.accessory.getService(this.hap.Service.Fanv2);
    if (!svc) {
      this.log.error(`Fanv2 service missing on ${this.name}`);
      return;
    }
    const C = this.C;

    svc.getCharacteristic(C.Active)
      .onGet(() => this.getActiveState());

    svc.getCharacteristic(C.CurrentFanState)
      .onGet(() => this.getCurrentFanState());

    svc.getCharacteristic(C.TargetFanState)
      .onGet(() => this.getTargetFanState())
      .onSet((v) => this.setTargetFanState(v));

    svc.getCharacteristic(C.RotationSpeed)
      .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
      .onGet(() => this.getRotationSpeed())
      .onSet((v) => this.setRotationSpeed(v));
  }

  // ─── Getters ──────────────────────────────────────────────────────────────────

  private async getActiveState(): Promise<CharacteristicValue> {
    const zone = await this.client.getZoneStatus(this.zoneId);
    return zone['fan'][0] === 'off'
      ? this.C.Active.INACTIVE
      : this.C.Active.ACTIVE;
  }

  private async getCurrentFanState(): Promise<CharacteristicValue> {
    const zone = await this.client.getZoneStatus(this.zoneId);
    return zone['fan'][0] === 'off'
      ? this.C.CurrentFanState.IDLE
      : this.C.CurrentFanState.BLOWING_AIR;
  }

  private async getTargetFanState(): Promise<CharacteristicValue> {
    const activity = await this.getScheduledActivity();
    return String(activity?.['fan']?.[0]) === 'auto'
      ? this.C.TargetFanState.AUTO
      : this.C.TargetFanState.MANUAL;
  }

  private async getRotationSpeed(): Promise<CharacteristicValue> {
    const activity = await this.getScheduledActivity();
    const fan = String(activity?.['fan']?.[0] ?? 'auto') as FanSpeed;
    return this.fanSpeedToPercent(fan);
  }

  // ─── Setters ──────────────────────────────────────────────────────────────────

  private async setTargetFanState(value: CharacteristicValue): Promise<void> {
    if (value === this.C.TargetFanState.AUTO) {
      // Switching to auto — set fan to 'auto' on the current activity
      await this.setFanSpeed('auto');
    } else {
      // Switching to manual — default to 'low' if currently auto
      const activity = await this.getScheduledActivity();
      const current = String(activity?.['fan']?.[0] ?? 'auto') as FanSpeed;
      const target = current === 'auto' ? 'low' : current;
      await this.setFanSpeed(target);
    }
  }

  private async setRotationSpeed(value: CharacteristicValue): Promise<void> {
    const speed = this.percentToFanSpeed(value as number);
    this.log.debug(`Setting fan speed to ${speed} (${value}%)`);
    await this.setFanSpeed(speed);
  }

  // ─── Fan speed helpers ────────────────────────────────────────────────────────

  /**
   * Set the fan speed via the activity API.
   * Uses the current activity (or 'manual' if no hold) and applies holdUntil.
   */
  private async setFanSpeed(speed: FanSpeed): Promise<void> {
    const system = await this.client.getSystem();
    const zone = system.status['zones'][0]['zone'].find((z) => z['id'] === this.zoneId);
    let activity = String(zone?.['currentActivity']?.[0] ?? 'manual');

    // If not already in a hold, set a manual hold first
    if (zone?.['hold']?.[0] !== 'on') {
      const holdDuration = this.config.holdUntil ?? 'forever';
      await this.client.setActivity(this.zoneId, 'manual', holdDuration);
      activity = 'manual';
    }

    await this.client.setFanSpeed(this.zoneId, activity, speed);
  }

  /**
   * Map HomeKit RotationSpeed percentage to Infinitude fan speed string.
   *
   * 0%       → off
   * 1–33%    → low
   * 34–66%   → med
   * 67–100%  → high
   */
  private percentToFanSpeed(percent: number): FanSpeed {
    if (percent === 0)   return 'off';
    if (percent <= 33)   return 'low';
    if (percent <= 66)   return 'med';
    return 'high';
  }

  /**
   * Map Infinitude fan speed string to HomeKit RotationSpeed percentage.
   */
  private fanSpeedToPercent(speed: FanSpeed): number {
    switch (speed) {
      case 'off':  return 0;
      case 'low':  return 33;
      case 'med':  return 66;
      case 'high': return 100;
      case 'auto': return 50; // midpoint — auto doesn't have a fixed speed
      default:     return 0;
    }
  }

  // ─── Schedule helper ──────────────────────────────────────────────────────────

  private async getScheduledActivity() {
    const system = await this.client.getSystem();
    const localTime = String(system.status['localTime'][0]).substring(0, 19);
    const systemDate = new Date(localTime);
    const dayOfWeek = systemDate.getDay();
    const time = systemDate.getHours() * 100 + systemDate.getMinutes();

    const zoneConfig = system.config['zones'][0]['zone'].find((z) => z['id'] === this.zoneId);
    if (!zoneConfig) return null;

    const activePeriods = zoneConfig['program'][0]['day'][dayOfWeek]['period'].filter((p) => {
      const [h, m] = String(p['time'][0]).split(':');
      const periodTime = parseInt(h) * 100 + parseInt(m);
      return String(p['enabled'][0]) === 'on' && periodTime <= time;
    });

    let activityName: string;
    if (activePeriods.length > 0) {
      activityName = String(activePeriods[activePeriods.length - 1]['activity'][0]);
    } else {
      const zoneStatus = system.status['zones'][0]['zone'].find((z) => z['id'] === this.zoneId);
      activityName = String(zoneStatus?.['currentActivity']?.[0] ?? 'home');
    }

    return zoneConfig['activities'][0]['activity'].find((a) => a['id'] === activityName) ?? null;
  }
}
