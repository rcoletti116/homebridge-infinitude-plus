import { Service, Characteristic, CharacteristicValue, PlatformAccessory, API } from 'homebridge';
import { InfinitudeClient } from './InfinitudeClient';
import { InfinitudeLog } from './InfinitudeLog';
import {
  ThermostatConfig,
  MIN_COOL_C,
  MAX_COOL_C,
  MIN_HEAT_C,
  MAX_HEAT_C,
  FakeGatoHistoryService,
  FakeGatoFactory,
} from './types';

/**
 * Represents a single zone thermostat in HomeKit.
 *
 * Characteristics exposed:
 *   - CurrentTemperature
 *   - TargetTemperature
 *   - CurrentHeatingCoolingState
 *   - TargetHeatingCoolingState
 *   - HeatingThresholdTemperature
 *   - CoolingThresholdTemperature
 *   - CurrentRelativeHumidity
 *   - FilterLifeLevel
 *   - FilterChangeIndication
 *   - TemperatureDisplayUnits (set to FAHRENHEIT by default)
 */
const POLL_INTERVAL_MS = 15_000;

export class InfinitudeThermostat {
  private readonly C: typeof Characteristic;
  private historyService?: FakeGatoHistoryService;
  private pollTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly name: string,
    private readonly zoneId: string,
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
    this.registerHandlers();
    this.startPolling();
  }

  // ─── Fakegato history ──────────────────────────────────────────────────────

  private initFakegato(): void {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const FakeGatoHistoryService = (require('fakegato-history') as FakeGatoFactory)(this.api);
      const acc = this.accessory as unknown as { log: InfinitudeLog; services: Service[] };
      acc.log = this.log;
      this.historyService = new FakeGatoHistoryService('room', this.accessory as never, {
        size: 4032,
        storage: 'fs',
        path: this.api.user.storagePath(),
      });
      (this.accessory as unknown as { services: unknown[] }).services.push(this.historyService);
      this.log.debug(`Fakegato history initialized for ${this.name}`);
    } catch (err) {
      this.log.debug(`fakegato-history not available (${err}) — install with: npm install fakegato-history`);
    }
  }

  // --- AccessoryInformation ---------------------------------------------------

  private bindInformation(): void {
    const svc = this.accessory.getService(this.hap.Service.AccessoryInformation);
    if (!svc || !this.config.advancedDetails) return;
    const { manufacturer, model, serial } = this.config.advancedDetails;
    svc
      .setCharacteristic(this.C.Manufacturer, manufacturer ?? 'Carrier')
      .setCharacteristic(this.C.Model, model ?? 'Infinity Touch')
      .setCharacteristic(this.C.SerialNumber, serial ?? 'N/A');
  }

  // --- Characteristic registration --------------------------------------------

  private registerHandlers(): void {
    const svc = this.accessory.getService(this.hap.Service.Thermostat);
    if (!svc) {
      this.log.error(`Thermostat service missing on ${this.name}`);
      return;
    }
    const C = this.C;

    svc.setCharacteristic(C.TemperatureDisplayUnits, C.TemperatureDisplayUnits.FAHRENHEIT);

    svc.getCharacteristic(C.CurrentTemperature)
      .onGet(() => this.getCurrentTemperature());

    svc.getCharacteristic(C.TargetTemperature)
      .onGet(() => this.getTargetTemperature())
      .onSet((v) => this.setTargetTemperature(v));

    svc.getCharacteristic(C.CurrentHeatingCoolingState)
      .onGet(() => this.getCurrentHeatingCoolingState());

    svc.getCharacteristic(C.TargetHeatingCoolingState)
      .onGet(() => this.getTargetHeatingCoolingState())
      .onSet((v) => this.setTargetHeatingCoolingState(v));

    svc.getCharacteristic(C.HeatingThresholdTemperature)
      .onGet(() => this.getHeatingThreshold())
      .onSet((v) => this.setHeatingThreshold(v));

    svc.getCharacteristic(C.CoolingThresholdTemperature)
      .onGet(() => this.getCoolingThreshold())
      .onSet((v) => this.setCoolingThreshold(v));

    svc.getCharacteristic(C.CurrentRelativeHumidity)
      .onGet(() => this.getCurrentRelativeHumidity());

    svc.getCharacteristic(C.FilterLifeLevel)
      .onGet(() => this.getFilterLifeLevel());

    svc.getCharacteristic(C.FilterChangeIndication)
      .onGet(() => this.getFilterChangeIndication());

  }

  // --- Getters ----------------------------------------------------------------

  private async getCurrentTemperature(): Promise<CharacteristicValue> {
    const scale = await this.client.getTemperatureScale();
    const zone = await this.client.getZoneStatus(this.zoneId);
    const temp = this.toHomeKit(parseFloat(zone['rt'][0]), scale);
    const humidity = parseFloat(zone['rh'][0]);
    // Log to fakegato history (room type: temp + humidity)
    if (this.historyService) {
      this.historyService.addEntry({
        time: Math.round(Date.now() / 1000),
        temp,
        humidity,
      });
    }
    return temp;
  }

  private async getTargetTemperature(): Promise<CharacteristicValue> {
    const { htsp, clsp, currentTemp, mode } = await this.getTemperatures();
    if (mode === 'heat' || mode === 'hpheat') return htsp;
    if (mode === 'cool') return clsp;
    return currentTemp;
  }

  private async getCurrentHeatingCoolingState(): Promise<CharacteristicValue> {
    const zone = await this.client.getZoneStatus(this.zoneId);
    switch (zone['zoneconditioning'][0]) {
      case 'active_heat': return this.C.CurrentHeatingCoolingState.HEAT;
      case 'idle':        return this.C.CurrentHeatingCoolingState.OFF;
      default:            return this.C.CurrentHeatingCoolingState.COOL;
    }
  }

  private async getTargetHeatingCoolingState(): Promise<CharacteristicValue> {
    const system = await this.client.getSystem();
    const zone = system.status['zones'][0]['zone'].find((z) => z['id'] === this.zoneId);
    if (zone?.['hold']?.[0] === 'on' && zone?.['currentActivity']?.[0] === 'away') {
      return this.C.TargetHeatingCoolingState.OFF;
    }
    const mode = String(system.config['mode'][0]);
    switch (mode) {
      case 'auto':   return this.C.TargetHeatingCoolingState.AUTO;
      case 'heat':
      case 'hpheat': return this.C.TargetHeatingCoolingState.HEAT;
      case 'cool':   return this.C.TargetHeatingCoolingState.COOL;
      default:       return this.C.TargetHeatingCoolingState.OFF;
    }
  }

  private async getHeatingThreshold(): Promise<CharacteristicValue> {
    return (await this.getTemperatures()).htsp;
  }

  private async getCoolingThreshold(): Promise<CharacteristicValue> {
    return (await this.getTemperatures()).clsp;
  }

  private async getCurrentRelativeHumidity(): Promise<CharacteristicValue> {
    const zone = await this.client.getZoneStatus(this.zoneId);
    return parseFloat(zone['rh'][0]);
  }

  private async getFilterLifeLevel(): Promise<CharacteristicValue> {
    const raw = await this.client.getFilterLifeLevel();
    // Invert: 100 = new filter, 0 = needs replacement
    return 100 - raw;
  }

  private async getFilterChangeIndication(): Promise<CharacteristicValue> {
    const level = (await this.getFilterLifeLevel()) as number;
    return level < 10
      ? this.C.FilterChangeIndication.CHANGE_FILTER
      : this.C.FilterChangeIndication.FILTER_OK;
  }

  // --- Setters ----------------------------------------------------------------

  private async setTargetTemperature(value: CharacteristicValue): Promise<void> {
    const scale = await this.client.getTemperatureScale();
    const nextTime = await this.getNextActivityTime();

    let activity: string | null = null;
    if (!nextTime) {
      const holdDuration = this.config.holdUntil ?? 'forever';
      await this.client.setActivity(this.zoneId, 'manual', holdDuration);
      activity = 'manual';
    }

    const state = await this.getTargetHeatingCoolingState();
    const setpoint =
      state === this.C.TargetHeatingCoolingState.HEAT ? 'htsp' : 'clsp';

    await this.client.setTargetTemperature(
      this.zoneId,
      this.toInfinitude(value as number, scale),
      setpoint,
      activity,
    );
  }

  private async setTargetHeatingCoolingState(value: CharacteristicValue): Promise<void> {
    const C = this.C;
    switch (value) {
      case C.TargetHeatingCoolingState.OFF:
        if (this.config.shutOffAway) {
          const until = await this.resolveHoldUntil();
          await this.client.setActivity(this.zoneId, 'away', until);
        } else {
          await this.client.removeHold(this.zoneId);
          await this.client.setSystemMode('off');
        }
        break;
      case C.TargetHeatingCoolingState.AUTO:
        await this.client.removeHold(this.zoneId);
        await this.client.setSystemMode('auto');
        break;
      case C.TargetHeatingCoolingState.HEAT:
        await this.client.removeHold(this.zoneId);
        await this.client.setSystemMode('heat');
        break;
      case C.TargetHeatingCoolingState.COOL:
        await this.client.removeHold(this.zoneId);
        await this.client.setSystemMode('cool');
        break;
    }
  }

  private async setHeatingThreshold(value: CharacteristicValue): Promise<void> {
    const scale = await this.client.getTemperatureScale();
    await this.client.setTargetTemperature(
      this.zoneId,
      this.toInfinitude(value as number, scale),
      'htsp',
      null,
    );
  }

  private async setCoolingThreshold(value: CharacteristicValue): Promise<void> {
    const scale = await this.client.getTemperatureScale();
    await this.client.setTargetTemperature(
      this.zoneId,
      this.toInfinitude(value as number, scale),
      'clsp',
      null,
    );
  }

  // --- Schedule helpers -------------------------------------------------------

  private async resolveHoldUntil(): Promise<string> {
    if (this.config.holdUntilNextActivity) {
      const next = await this.getNextActivityTime();
      if (next) return next;
    }
    return this.config.holdUntil ?? 'forever';
  }

  private async getNextActivityTime(): Promise<string | null> {
    const system = await this.client.getSystem();
    const localTime = String(system.status['localTime'][0]).substring(0, 19);
    const systemDate = new Date(localTime);
    let dayOfWeek = systemDate.getDay();
    const now = systemDate.getHours() * 100 + systemDate.getMinutes();
    const initialDay = dayOfWeek;

    const zoneConfig = system.config['zones'][0]['zone'].find((z) => z['id'] === this.zoneId);
    if (!zoneConfig) return null;

    const findNext = (day: number, afterTime: number) =>
      zoneConfig['program'][0]['day'][day]['period'].find((p) => {
        const [h, m] = String(p['time'][0]).split(':');
        const t = parseInt(h) * 100 + parseInt(m);
        return String(p['enabled'][0]) === 'on' && t > afterTime;
      });

    let period = findNext(dayOfWeek, now);
    while (!period) {
      dayOfWeek = (dayOfWeek + 1) % 7;
      if (dayOfWeek === initialDay) return null;
      period = findNext(dayOfWeek, -1);
    }
    return String(period['time'][0]);
  }

  // --- Temperature helpers ----------------------------------------------------

  private async getTemperatures(): Promise<{
    htsp: number;
    clsp: number;
    currentTemp: number;
    mode: string;
  }> {
    const scale = await this.client.getTemperatureScale();
    const system = await this.client.getSystem();
    const zone = system.status['zones'][0]['zone'].find((z) => z['id'] === this.zoneId);
    if (!zone) throw new Error(`Zone ${this.zoneId} not found`);

    const htsp = this.clamp(
      this.toHomeKit(parseFloat(zone['htsp'][0]), scale),
      MIN_HEAT_C, MAX_HEAT_C,
    );
    const clsp = this.clamp(
      this.toHomeKit(parseFloat(zone['clsp'][0]), scale),
      MIN_COOL_C, MAX_COOL_C,
    );
    const currentTemp = this.toHomeKit(parseFloat(zone['rt'][0]), scale);
    const mode = String(system.config['mode'][0]);

    this.log.verbose(`getTemperatures zone=${this.zoneId} htsp=${htsp} clsp=${clsp} mode=${mode}`);
    return { htsp, clsp, currentTemp, mode };
  }

  private clamp(v: number, min: number, max: number): number {
    return Math.min(Math.max(v, min), max);
  }

  private toHomeKit(temperature: number, scale: string): number {
    const t = scale === 'F' ? this.client.fahrenheitToCelsius(temperature) : temperature;
    return parseFloat(t.toFixed(1));
  }

  private toInfinitude(temperature: number, scale: string): string {
    const t = scale === 'F' ? this.client.celsiusToFahrenheit(temperature) : temperature;
    return parseFloat(t.toString()).toFixed(1);
  }

  // ─── Background polling ───────────────────────────────────────────────────

  private startPolling(): void {
    // Push an immediate update, then refresh every POLL_INTERVAL_MS.
    // This keeps HomeKit current without waiting for a HomeKit-initiated read.
    this.pushUpdates();
    this.pollTimer = setInterval(() => this.pushUpdates(), POLL_INTERVAL_MS);
  }

  stopPolling(): void {
    if (this.pollTimer !== undefined) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private pushUpdates(): void {
    const svc = this.accessory.getService(this.hap.Service.Thermostat);
    if (!svc) return;
    const C = this.C;

    // Fetch system state once and push all characteristics from it
    Promise.all([
      this.client.getSystem(),
      this.client.getTemperatureScale(),
      this.client.getFilterLifeLevel(),
    ]).then(([system, scale, rawFilter]) => {
      const zone = system.status['zones'][0]['zone'].find((z) => z['id'] === this.zoneId);
      if (!zone) return;

      // Current temperature
      const currentTemp = this.toHomeKit(parseFloat(zone['rt'][0]), scale);
      svc.updateCharacteristic(C.CurrentTemperature, currentTemp);

      // Humidity
      const humidity = parseFloat(zone['rh'][0]);
      svc.updateCharacteristic(C.CurrentRelativeHumidity, humidity);

      // Heating/cooling thresholds
      const htsp = this.clamp(this.toHomeKit(parseFloat(zone['htsp'][0]), scale), MIN_HEAT_C, MAX_HEAT_C);
      const clsp = this.clamp(this.toHomeKit(parseFloat(zone['clsp'][0]), scale), MIN_COOL_C, MAX_COOL_C);
      svc.updateCharacteristic(C.HeatingThresholdTemperature, htsp);
      svc.updateCharacteristic(C.CoolingThresholdTemperature, clsp);

      // Target temperature (mode-dependent)
      const mode = String(system.config['mode'][0]);
      const targetTemp = mode === 'heat' || mode === 'hpheat' ? htsp
                       : mode === 'cool' ? clsp
                       : currentTemp;
      svc.updateCharacteristic(C.TargetTemperature, targetTemp);

      // Current heating/cooling state
      switch (zone['zoneconditioning'][0]) {
        case 'active_heat':
          svc.updateCharacteristic(C.CurrentHeatingCoolingState, C.CurrentHeatingCoolingState.HEAT);
          break;
        case 'idle':
          svc.updateCharacteristic(C.CurrentHeatingCoolingState, C.CurrentHeatingCoolingState.OFF);
          break;
        default:
          svc.updateCharacteristic(C.CurrentHeatingCoolingState, C.CurrentHeatingCoolingState.COOL);
      }

      // Target heating/cooling state
      if (zone['hold']?.[0] === 'on' && String(zone['currentActivity']?.[0]) === 'away') {
        svc.updateCharacteristic(C.TargetHeatingCoolingState, C.TargetHeatingCoolingState.OFF);
      } else {
        switch (mode) {
          case 'auto':   svc.updateCharacteristic(C.TargetHeatingCoolingState, C.TargetHeatingCoolingState.AUTO); break;
          case 'heat':
          case 'hpheat': svc.updateCharacteristic(C.TargetHeatingCoolingState, C.TargetHeatingCoolingState.HEAT); break;
          case 'cool':   svc.updateCharacteristic(C.TargetHeatingCoolingState, C.TargetHeatingCoolingState.COOL); break;
          default:       svc.updateCharacteristic(C.TargetHeatingCoolingState, C.TargetHeatingCoolingState.OFF);
        }
      }

      // Filter (inverted: 100 = new, 0 = replace)
      const filterLevel = 100 - rawFilter;
      svc.updateCharacteristic(C.FilterLifeLevel, filterLevel);
      svc.updateCharacteristic(
        C.FilterChangeIndication,
        filterLevel < 10 ? C.FilterChangeIndication.CHANGE_FILTER : C.FilterChangeIndication.FILTER_OK,
      );

      // Fakegato history entry
      if (this.historyService) {
        this.historyService.addEntry({
          time: Math.round(Date.now() / 1000),
          temp: currentTemp,
          humidity,
        });
      }

      this.log.verbose(`Poll pushed updates for ${this.name}: ${currentTemp}°C, ${humidity}% RH, mode=${mode}`);
    }).catch((err) => {
      this.log.warn(`Poll failed for ${this.name}: ${err}`);
    });
  }

}