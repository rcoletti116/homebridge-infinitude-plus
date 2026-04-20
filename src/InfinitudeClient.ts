import axios from 'axios';
import { InfinitudeLog } from './InfinitudeLog';
import {
  SystemStatus,
  SystemConfig,
  InfinitudeSystem,
  ZoneStatus,
  ZoneConfig,
  CLIENT_TIMEOUT_MS,
} from './types';

/**
 * HTTP client for the Infinitude local API.
 *
 * Key API facts (from https://github.com/nebulous/infinitude/wiki/Infinitude-API-calls):
 *
 *   GET  /api/status/              → full system status JSON
 *   GET  /api/status/{zoneId}      → single zone status (more efficient)
 *   GET  /api/status/{path}        → scalar value at path
 *   GET  /api/config/              → full system config JSON
 *   GET  /api/config?key=val&set_changes=true  → mutate config
 *   GET  /api/{zoneId}/hold?activity=X&until=Y → set hold
 *   GET  /api/{zoneId}/hold?hold=off           → remove hold
 *   GET  /api/{zoneId}/activity/{activity}?clsp=X&htsp=Y&fan=Z → set setpoints/fan
 */
export class InfinitudeClient {
  static readonly REFRESH_MS = 10_000;

  constructor(
    private readonly url: string,
    private readonly log: InfinitudeLog,
  ) {}

  // ─── Low-level fetch ───────────────────────────────────────────────────────

  private async fetch<T = unknown>(path: string): Promise<T> {
    this.log.verbose(`GET ${this.url}${path}`);
    try {
      const response = await axios.get<T>(`${this.url}${path}`, {
        timeout: CLIENT_TIMEOUT_MS,
      });
      this.log.verbose(`  ← ${path}: ${JSON.stringify(response.data)}`);
      return response.data;
    } catch (err) {
      this.log.error(`Request failed [${path}]: ${err}`);
      throw err;
    }
  }

  // ─── Read — status ─────────────────────────────────────────────────────────

  async getStatus(): Promise<SystemStatus> {
    return this.fetch<SystemStatus>('/api/status/');
  }

  /**
   * Fetch a single zone's status directly via /api/status/{zoneId}.
   * More efficient than fetching all zones when only one zone is needed.
   */
  async getZoneStatus(zoneId: string): Promise<ZoneStatus> {
    const zone = await this.fetch<ZoneStatus>(`/api/status/${zoneId}`);
    if (!zone) throw new Error(`Zone ${zoneId} not found`);
    return zone;
  }

  async getOutdoorTemperature(): Promise<number> {
    // /api/status/oat returns {"oat": 32.0} — unwrap the value
    const resp = await this.fetch<Record<string, unknown>>('/api/status/oat');
    const raw = typeof resp === 'object' && resp !== null ? resp['oat'] ?? resp : resp;
    return parseFloat(String(raw));
  }

  async getFilterLifeLevel(): Promise<number> {
    // /api/status/filtrlvl returns {"filtrlvl": 85} — unwrap the value
    const resp = await this.fetch<Record<string, unknown>>('/api/status/filtrlvl');
    const raw = typeof resp === 'object' && resp !== null ? resp['filtrlvl'] ?? resp : resp;
    return parseFloat(String(raw));
  }

  // ─── Read — config ─────────────────────────────────────────────────────────

  async getConfig(): Promise<SystemConfig> {
    const wrapper = await this.fetch<{ data: SystemConfig }>('/api/config/');
    return wrapper['data'];
  }

  async getZoneConfig(zoneId: string): Promise<ZoneConfig> {
    const config = await this.getConfig();
    const zone = config['zones'][0]['zone'].find((z) => z['id'] === zoneId);
    if (!zone) throw new Error(`Zone ${zoneId} not found in config`);
    return zone;
  }

  async getTemperatureScale(): Promise<string> {
    const config = await this.getConfig();
    return config['cfgem'][0] as unknown as string;
  }

  // ─── Combined ──────────────────────────────────────────────────────────────

  async getSystem(): Promise<InfinitudeSystem> {
    const [status, config] = await Promise.all([this.getStatus(), this.getConfig()]);
    return { status, config };
  }

  // ─── Write — activity setpoints & fan ──────────────────────────────────────

  async setTargetTemperature(
    zoneId: string,
    targetTemperature: string,
    setpoint: 'htsp' | 'clsp',
    activity: string | null,
  ): Promise<void> {
    const zone = await this.getZoneStatus(zoneId);
    const resolvedActivity = activity ?? zone?.['currentActivity']?.[0] ?? 'manual';
    await this.fetch(`/api/${zoneId}/activity/${resolvedActivity}?${setpoint}=${targetTemperature}`);
  }

  /**
   * Set the fan speed for a zone's activity.
   * Valid values: 'off' | 'low' | 'med' | 'high' | 'auto'
   */
  async setFanSpeed(zoneId: string, activity: string, speed: string): Promise<void> {
    await this.fetch(`/api/${zoneId}/activity/${activity}?fan=${speed}`);
  }

  // ─── Write — hold ──────────────────────────────────────────────────────────

  async setActivity(zoneId: string, activity: string, until: string): Promise<void> {
    await this.fetch(`/api/${zoneId}/hold?activity=${activity}&until=${until}`);
  }

  async removeHold(zoneId: string): Promise<void> {
    await this.fetch(`/api/${zoneId}/hold?hold=off`);
  }

  // ─── Write — system config ─────────────────────────────────────────────────

  async setSystemMode(mode: string): Promise<void> {
    const config = await this.getConfig();
    const currentMode = config['mode'][0] as unknown as string;
    if (currentMode !== mode) {
      await this.fetch(`/api/config?mode=${mode}&set_changes=true`);
    }
  }

  // ─── Utilities ─────────────────────────────────────────────────────────────

  fahrenheitToCelsius(fahrenheit: number): number {
    return (fahrenheit - 32) / 1.8;
  }

  celsiusToFahrenheit(celsius: number): number {
    return celsius * 1.8 + 32;
  }
}
