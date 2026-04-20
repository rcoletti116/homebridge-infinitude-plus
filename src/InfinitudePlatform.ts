import {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Categories,
} from 'homebridge';

import { InfinitudeInstance } from './InfinitudeInstance';
import { InfinitudeLog } from './InfinitudeLog';
import {
  PlatformConfig as InfinitudeConfig,
  PLUGIN_NAME,
  PLATFORM_NAME,
  INIT_DELAY_MS,
} from './types';

/**
 * InfinitudePlatform — top-level Homebridge DynamicPlatformPlugin.
 *
 * Correct Homebridge DynamicPlatform lifecycle:
 *
 *   1. constructor        — validate config, build InfinitudeInstance list
 *   2. configureAccessory — called for every cached accessory BEFORE
 *                           didFinishLaunching. Stash them for later —
 *                           do NOT configure yet because zone maps aren't
 *                           populated until discoverZones() runs.
 *   3. didFinishLaunching — for each instance:
 *                           a. discoverZones() to populate UUID→zone maps
 *                           b. configure cached accessories (now maps exist)
 *                           c. create brand-new accessories for zones not in cache
 */
export class InfinitudePlatform implements DynamicPlatformPlugin {
  private readonly log: InfinitudeLog;
  private readonly pluginConfig: InfinitudeConfig;
  private readonly instances: InfinitudeInstance[] = [];

  /**
   * Cached accessories from previous runs, keyed by UUID.
   * Populated in configureAccessory, consumed in didFinishLaunching.
   */
  private readonly cachedAccessories = new Map<string, PlatformAccessory>();

  constructor(logger: Logger, platformConfig: PlatformConfig, private readonly api: API) {
    const cfg = platformConfig as unknown as InfinitudeConfig;
    this.log = new InfinitudeLog(logger, Boolean(cfg.verbose));
    this.pluginConfig = cfg;

    this.log.info('Plugin initializing…');

    if (!this.isValidConfig()) {
      this.log.warn(
        `${PLUGIN_NAME} is not configured correctly — add at least one thermostat and restart Homebridge.`,
      );
      return;
    }

    for (let i = 0; i < (this.pluginConfig.thermostats ?? []).length; i++) {
      this.instances.push(
        new InfinitudeInstance(i, this.log, this.pluginConfig.thermostats![i], this.api),
      );
    }

    this.api.on('didFinishLaunching', () => {
      this.didFinishLaunching().catch((err) =>
        this.log.error(`Unhandled error in didFinishLaunching: ${err}`),
      );
    });
  }

  // ─── Homebridge lifecycle ────────────────────────────────────────────────────

  /**
   * Called by Homebridge for every cached accessory before didFinishLaunching.
   * We stash them here — we can't configure them yet because discoverZones()
   * hasn't run so the UUID→zoneId maps are empty.
   */
  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info(`Caching restored accessory: ${accessory.displayName}`);
    this.cachedAccessories.set(accessory.UUID, accessory);
  }

  private async didFinishLaunching(): Promise<void> {
    await this.delay(INIT_DELAY_MS);

    for (const instance of this.instances) {
      try {
        await this.setupInstance(instance);
      } catch (err) {
        this.log.error(`Failed to initialize instance ${instance.id}: ${err}`);
      }
    }

    this.log.info('Platform initialized.');
  }

  // ─── Per-instance setup ──────────────────────────────────────────────────────

  private async setupInstance(instance: InfinitudeInstance): Promise<void> {
    // Step 1: discover zones from Infinitude — this populates the UUID→zone maps
    // on the instance. MUST happen before we try to configure any accessories.
    const zones = await instance.discoverZones();

    const thermostatConfig = this.pluginConfig.thermostats![instance.id];

    // Step 2: configure cached accessories now that maps are populated.
    // Track which UUIDs we've handled so we know what's new.
    const handledUuids = new Set<string>();

    for (const [uuid, acc] of this.cachedAccessories) {
      const ctx = acc.context as { instanceId?: number };
      if (ctx?.instanceId !== instance.id) continue;

      this.log.info(`Restoring cached accessory: ${acc.displayName}`);
      instance.restoreCachedAccessory(acc);
      handledUuids.add(uuid);
    }

    // Step 3: create brand-new accessories for zones not already in the cache.
    for (const { zoneId } of zones) {
      const tUuid = instance.thermostatUuid(zoneId);
      const fUuid = instance.fanUuid(zoneId);

      if (!this.cachedAccessories.has(tUuid)) {
        this.log.info(`Zone ${zoneId}: creating new thermostat`);
        instance.createZoneThermostat(zoneId);
      }

      if (thermostatConfig.useFan && !this.cachedAccessories.has(fUuid)) {
        this.log.info(`Zone ${zoneId}: creating new fan`);
        instance.createFan(zoneId);
      }
    }

    const outdoorUuid = instance.outdoorUuid();
    if (thermostatConfig.useOutdoorTemperatureSensor && !this.cachedAccessories.has(outdoorUuid)) {
      this.log.info(`Instance ${instance.id}: creating new outdoor sensor`);
      instance.createTemperatureSensor();
    }
  }

  // ─── Utilities ───────────────────────────────────────────────────────────────

  private isValidConfig(): boolean {
    return Array.isArray(this.pluginConfig?.thermostats) && this.pluginConfig.thermostats.length > 0;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
