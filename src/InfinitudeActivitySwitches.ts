import { Service, Characteristic, CharacteristicValue, PlatformAccessory } from 'homebridge';
import { InfinitudeClient } from './InfinitudeClient';
import { InfinitudeLog } from './InfinitudeLog';
import { ThermostatConfig } from './types';

type Hap = { Service: typeof Service; Characteristic: typeof Characteristic };

const ACTIVITIES = ['home', 'away', 'sleep', 'wake', 'manual'] as const;
type Activity = typeof ACTIVITIES[number];

const LABELS: Record<Activity, string> = {
  home: 'Home', away: 'Away', sleep: 'Sleep', wake: 'Wake', manual: 'Manual',
};

/**
 * One accessory per zone containing five Switch services — one per Infinity
 * activity preset (Home, Away, Sleep, Wake, Manual).
 *
 * Uses a unique subtype per switch so all five coexist on the same accessory.
 * Visible in Apple Home as individual switch tiles.
 *
 * Turning one ON: sets a hold for that activity (respects holdUntil config).
 * Turning one OFF: releases the hold if that activity is currently active.
 * After any change: syncs all five states from live zone status.
 */
export class InfinitudeActivitySwitches {
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
    this.registerSwitches();
  }

  // ─── AccessoryInformation ────────────────────────────────────────────────────

  private bindInformation(): void {
    const svc = this.accessory.getService(this.hap.Service.AccessoryInformation);
    if (!svc || !this.config.advancedDetails) return;
    const { manufacturer, model, serial } = this.config.advancedDetails;
    svc
      .setCharacteristic(this.C.Manufacturer, manufacturer ?? 'Carrier')
      .setCharacteristic(this.C.Model, model ?? 'Infinity Touch')
      .setCharacteristic(this.C.SerialNumber, `${serial ?? 'N/A'}-act`);
  }

  // ─── Switch registration ──────────────────────────────────────────────────────

  private registerSwitches(): void {
    for (const activity of ACTIVITIES) {
      const label = LABELS[activity];
      let svc = this.accessory.getServiceById(this.hap.Service.Switch, activity);
      if (!svc) {
        svc = this.accessory.addService(this.hap.Service.Switch, label, activity);
      }
      svc.setCharacteristic(this.C.Name, label);
      svc
        .getCharacteristic(this.C.On)
        .onGet(() => this.getState(activity))
        .onSet((v) => this.setState(activity, v));
    }
  }

  // ─── Getters / Setters ───────────────────────────────────────────────────────

  private async getState(activity: Activity): Promise<CharacteristicValue> {
    const zone = await this.client.getZoneStatus(this.zoneId);
    return zone['hold'][0] === 'on' && String(zone['currentActivity'][0]) === activity;
  }

  private async setState(activity: Activity, value: CharacteristicValue): Promise<void> {
    if (value) {
      const until = this.config.holdUntil ?? 'forever';
      this.log.info(`Activity: setting ${LABELS[activity]} hold until ${until}`);
      await this.client.setActivity(this.zoneId, activity, until);
    } else {
      const zone = await this.client.getZoneStatus(this.zoneId);
      if (String(zone['currentActivity'][0]) === activity && zone['hold'][0] === 'on') {
        this.log.info(`Activity: releasing hold`);
        await this.client.removeHold(this.zoneId);
      }
    }
    setTimeout(() => this.syncStates(), 500);
  }

  private syncStates(): void {
    this.client.getZoneStatus(this.zoneId)
      .then((zone) => {
        const current = String(zone['currentActivity'][0]);
        const hasHold = zone['hold'][0] === 'on';
        for (const activity of ACTIVITIES) {
          const svc = this.accessory.getServiceById(this.hap.Service.Switch, activity);
          svc?.updateCharacteristic(this.C.On, hasHold && current === activity);
        }
      })
      .catch((err) => this.log.warn(`Failed to sync activity switches: ${err}`));
  }
}
