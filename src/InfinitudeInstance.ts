import { API, PlatformAccessory, Service, Characteristic, Categories } from 'homebridge';
import { InfinitudeClient } from './InfinitudeClient';
import { InfinitudeThermostat } from './InfinitudeThermostat';
import { InfinitudeSensor } from './InfinitudeSensor';
import { InfinitudeFan } from './InfinitudeFan';
import { InfinitudeActivitySwitches } from './InfinitudeActivitySwitches';
import { InfinitudeLog } from './InfinitudeLog';
import { ThermostatConfig, PLUGIN_NAME, PLATFORM_NAME } from './types';

type Hap = { Service: typeof Service; Characteristic: typeof Characteristic };

export class InfinitudeInstance {
  readonly id: number;
  readonly client: InfinitudeClient;

  private readonly hap: Hap;
  private readonly zoneIds: Record<string, string> = {};
  private readonly zoneNames: Record<string, string> = {};

  constructor(
    id: number,
    private readonly log: InfinitudeLog,
    private readonly config: ThermostatConfig,
    private readonly api: API,
  ) {
    this.id = id;
    this.client = new InfinitudeClient(config.url, log);
    this.hap = { Service: api.hap.Service, Characteristic: api.hap.Characteristic };
    this.log.info(`Creating instance ${id} (${config.name})`);
  }

  // ─── UUID helpers ────────────────────────────────────────────────────────────

  thermostatUuid(zoneId: string): string {
    return this.api.hap.uuid.generate(`${this.id}_${zoneId}_tstat`);
  }

  fanUuid(zoneId: string): string {
    return this.api.hap.uuid.generate(`${this.id}_${zoneId}_fan`);
  }

  activitySwitchesUuid(zoneId: string): string {
    return this.api.hap.uuid.generate(`${this.id}_${zoneId}_activity`);
  }

  outdoorUuid(): string {
    return this.api.hap.uuid.generate(`${this.id}_outdoorSensor`);
  }

  // ─── Zone discovery ──────────────────────────────────────────────────────────

  /**
   * Fetch enabled zones from Infinitude and populate the internal
   * zoneId / zoneName maps. Does NOT create or register any accessories —
   * that is handled separately by setupZone / setupOutdoorSensor.
   */
  async discoverZones(): Promise<Array<{ zoneId: string; zoneName: string }>> {
    const status = await this.client.getStatus();
    const zones = status['zones'][0]['zone'].filter(
      (z) => String(z['enabled'][0]) === 'on',
    );

    const result: Array<{ zoneId: string; zoneName: string }> = [];

    for (const zone of zones) {
      const zoneId   = String(zone['id']);
      const zoneName = String(zone['name']);
      const tUuid    = this.thermostatUuid(zoneId);
      const fUuid    = this.fanUuid(zoneId);

      const aUuid = this.activitySwitchesUuid(zoneId);
      this.zoneIds[tUuid]   = zoneId;
      this.zoneIds[fUuid]   = zoneId;
      this.zoneIds[aUuid]   = zoneId;
      this.zoneNames[tUuid] = `${this.config.name} ${zoneName} Thermostat`;
      this.zoneNames[fUuid] = `${this.config.name} ${zoneName} Fan`;
      this.zoneNames[aUuid] = `${this.config.name} ${zoneName} Activities`;

      result.push({ zoneId, zoneName });
    }

    return result;
  }

  // ─── Accessory restore (cached accessories) ──────────────────────────────────

  /**
   * Called by the platform for every accessory Homebridge has in its cache.
   * We restore the zone mappings from the accessory's context and wire up
   * the service handlers — but do NOT re-register with Homebridge.
   */
  restoreCachedAccessory(accessory: PlatformAccessory): void {
    const ctx = accessory.context as {
      zoneId?: string;
      zoneName?: string;
      instanceId?: number;
    };

    // Restore mappings from persisted context
    if (ctx.zoneId)   this.zoneIds[accessory.UUID]   = ctx.zoneId;
    if (ctx.zoneName) this.zoneNames[accessory.UUID] = ctx.zoneName;

    const category = accessory.category as Categories;

    switch (category) {
      case Categories.THERMOSTAT:
        this.configureZoneThermostat(accessory);
        break;
      case Categories.SENSOR:
      case Categories.OTHER:
        this.configureTemperatureSensor(accessory);
        break;
      case Categories.FAN:
        this.configureFan(accessory);
        break;
      case Categories.SWITCH:
        this.configureActivitySwitches(accessory);
        break;
      default:
        this.log.warn(`Unknown category ${category} for ${accessory.displayName} — skipping`);
    }
  }

  // ─── Accessory creation (new accessories only) ───────────────────────────────

  /**
   * Create and register a thermostat accessory for a zone.
   * Only call this if the UUID is NOT already in the Homebridge cache.
   */
  createZoneThermostat(zoneId: string): PlatformAccessory {
    const uuid = this.thermostatUuid(zoneId);
    const name = this.zoneNames[uuid];
    this.log.info(`Creating new thermostat: ${name}`);

    const acc = new this.api.platformAccessory(name, uuid, Categories.THERMOSTAT);
    acc.addService(this.api.hap.Service.Thermostat, name);
    acc.context = { zoneId, zoneName: name, instanceId: this.id };

    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]);
    this.configureZoneThermostat(acc);
    return acc;
  }

  createTemperatureSensor(): PlatformAccessory {
    const uuid = this.outdoorUuid();
    this.log.info(`Creating new outdoor temperature sensor`);

    const acc = new this.api.platformAccessory('Outdoor', uuid, Categories.SENSOR);
    acc.addService(this.api.hap.Service.TemperatureSensor);
    acc.context = { instanceId: this.id };

    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]);
    this.configureTemperatureSensor(acc);
    return acc;
  }

  createFan(zoneId: string): PlatformAccessory {
    const uuid = this.fanUuid(zoneId);
    const name = this.zoneNames[uuid];
    this.log.info(`Creating new fan: ${name}`);

    const acc = new this.api.platformAccessory(name, uuid, Categories.FAN);
    acc.addService(this.api.hap.Service.Fanv2, name);
    acc.context = { zoneId, zoneName: name, instanceId: this.id };

    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]);
    this.configureFan(acc);
    return acc;
  }

  // ─── Service handler wiring ──────────────────────────────────────────────────

  configureZoneThermostat(accessory: PlatformAccessory): void {
    const name   = this.zoneNames[accessory.UUID] ?? String(accessory.displayName);
    const zoneId = this.zoneIds[accessory.UUID];
    this.log.debug(`Configuring thermostat: ${name} (zone ${zoneId})`);
    new InfinitudeThermostat(name, zoneId, this.client, this.log, this.config, accessory, this.hap, this.api);
  }

  configureTemperatureSensor(accessory: PlatformAccessory): void {
    this.log.debug(`Configuring outdoor sensor`);
    new InfinitudeSensor('Outdoor', this.client, this.log, this.config, accessory, this.hap, this.api);
  }

  createActivitySwitches(zoneId: string): PlatformAccessory {
    const uuid = this.activitySwitchesUuid(zoneId);
    const name = this.zoneNames[uuid];
    this.log.info(`Creating activity switches: ${name}`);
    const acc = new this.api.platformAccessory(name, uuid, Categories.SWITCH);
    acc.addService(this.api.hap.Service.Switch, 'Home', 'home');
    acc.context = { zoneId, zoneName: name, instanceId: this.id };
    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]);
    this.configureActivitySwitches(acc);
    return acc;
  }

  configureFan(accessory: PlatformAccessory): void {
    const name   = this.zoneNames[accessory.UUID] ?? String(accessory.displayName);
    const zoneId = this.zoneIds[accessory.UUID];
    this.log.debug(`Configuring fan: ${name} (zone ${zoneId})`);
    new InfinitudeFan(name, zoneId, this.client, this.log, this.config, accessory, this.hap);
  }

  configureActivitySwitches(accessory: PlatformAccessory): void {
    const name   = this.zoneNames[accessory.UUID] ?? String(accessory.displayName);
    const zoneId = this.zoneIds[accessory.UUID];
    this.log.debug(`Configuring activity switches: ${name} (zone ${zoneId})`);
    new InfinitudeActivitySwitches(name, zoneId, this.client, this.log, this.config, accessory, this.hap);
  }
}
