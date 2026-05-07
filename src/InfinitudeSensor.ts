import { Service, Characteristic, PlatformAccessory, API } from 'homebridge';
import { InfinitudeClient } from './InfinitudeClient';
import { InfinitudeLog } from './InfinitudeLog';
import {
  ThermostatConfig,
  DEFAULT_SENSOR_POLL_MS,
  FakeGatoHistoryService,
  FakeGatoFactory,
} from './types';

/**
 * Outdoor temperature sensor accessory.
 *
 * - Polls Infinitude's /api/status/oat at a configurable interval
 * - Pushes updates to HomeKit via updateCharacteristic (no HomeKit polling needed)
 * - Logs temperature history via fakegato-history ("weather" type, visible in Eve app)
 */
export class InfinitudeSensor {
  private readonly C: typeof Characteristic;
  private pollTimer?: ReturnType<typeof setInterval>;
  private historyService?: FakeGatoHistoryService;

  constructor(
    private readonly name: string,
    private readonly client: InfinitudeClient,
    private readonly log: InfinitudeLog,
    private readonly config: ThermostatConfig,
    private readonly accessory: PlatformAccessory,
    private readonly hap: { Service: typeof Service; Characteristic: typeof Characteristic },
    private readonly api: API,
  ) {
    this.C = hap.Characteristic;
    this.bindInformation();
    this.initFakegato();
    this.startPolling();
  }

  // ─── AccessoryInformation ────────────────────────────────────────────────

  private bindInformation(): void {
    const svc = this.accessory.getService(this.hap.Service.AccessoryInformation);
    if (!svc || !this.config.advancedDetails) return;
    const { manufacturer, model, serial } = this.config.advancedDetails;
    svc
      .setCharacteristic(this.C.Manufacturer, manufacturer ?? 'Carrier')
      .setCharacteristic(this.C.Model, model ?? 'Infinity Touch')
      .setCharacteristic(this.C.SerialNumber, `${serial ?? 'N/A'}-s`);
  }

  // ─── Fakegato history ────────────────────────────────────────────────────

  private initFakegato(): void {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const FakeGatoHistoryService = (require('fakegato-history') as FakeGatoFactory)(this.api);

      // fakegato requires accessory.log and accessory.services to be accessible
      const acc = this.accessory as unknown as {
        log: InfinitudeLog;
        services: Service[];
      };
      acc.log = this.log;

      this.historyService = new FakeGatoHistoryService('weather', this.accessory as never, {
        size: 4032,
        storage: 'fs',
        path: this.api.user.storagePath(),
      });

      // Register the fakegato service on the accessory so it persists
      (this.accessory as unknown as { services: unknown[] }).services.push(this.historyService);

      this.log.debug(`Fakegato history initialized for ${this.name}`);
    } catch (err) {
      this.log.warn(`fakegato-history not available (${err}) — install with: npm install fakegato-history`);
    }
  }

  // ─── Polling ─────────────────────────────────────────────────────────────

  private startPolling(): void {
    const intervalMs = this.config.sensorpoll ?? DEFAULT_SENSOR_POLL_MS;
    this.pushTemperatureUpdate();
    this.pollTimer = setInterval(() => this.pushTemperatureUpdate(), intervalMs);
  }

  stopPolling(): void {
    if (this.pollTimer !== undefined) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private pushTemperatureUpdate(): void {
    const svc = this.accessory.getService(this.hap.Service.TemperatureSensor);
    if (!svc) return;

    this.client
      .getOutdoorTemperature()
      .then((rawF) => {
        const celsius = parseFloat(this.client.fahrenheitToCelsius(rawF).toFixed(1));
        svc.updateCharacteristic(this.C.CurrentTemperature, celsius);
        this.log.verbose(`Outdoor temperature updated: ${celsius}°C`);

        // Record in fakegato history
        if (this.historyService) {
          this.historyService.addEntry({ time: Math.round(Date.now() / 1000), temp: celsius });
        }
      })
      .catch((err: unknown) => {
        this.log.warn(`Failed to update outdoor temperature: ${err}`);
      });
  }
}
