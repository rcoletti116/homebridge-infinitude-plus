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

const CACHE_TTL_MS = 10_000; // serve reads from cache for 10 seconds

interface CacheEntry<T> {
  value: T;
  expires: number;
}

/**
 * HTTP client for the Infinitude local API.
 *
 * Caches status and config responses for CACHE_TTL_MS to prevent
 * parallel HomeKit characteristic reads from hammering Infinitude
 * with redundant HTTP requests.
 */
export class InfinitudeClient {
  static readonly REFRESH_MS = 10_000;

  private statusCache?: CacheEntry<SystemStatus>;
  private configCache?: CacheEntry<SystemConfig>;

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

  // ─── Cached reads ──────────────────────────────────────────────────────────

  async getStatus(): Promise<SystemStatus> {
    const now = Date.now();
    if (this.statusCache && now < this.statusCache.expires) {
      return this.statusCache.value;
    }
    const value = await this.fetch<SystemStatus>('/api/status/');
    this.statusCache = { value, expires: now + CACHE_TTL_MS };
    return value;
  }

  async getConfig(): Promise<SystemConfig> {
    const now = Date.now();
    if (this.configCache && now < this.configCache.expires) {
      return this.configCache.value;
    }
    const wrapper = await this.fetch<{ data: SystemConfig }>('/api/config/');
    const value = wrapper['data'];
    this.configCache = { value, expires: now + CACHE_TTL_MS };
    return value;
  }

  /** Invalidate the cache after a write so the next read is fresh. */
  private invalidateCache(): void {
    this.statusCache = undefined;
    this.configCache = undefined;
  }

  // ─── Derived reads ─────────────────────────────────────────────────────────

  async getZoneStatus(zoneId: string): Promise<ZoneStatus> {
    // Use cached full status rather than a separate HTTP call per zone
    const status = await this.getStatus();
    const zone = status['zones'][0]['zone'].find((z) => z['id'] === zoneId);
    if (!zone) throw new Error(`Zone ${zoneId} not found`);
    return zone;
  }

  async getZoneConfig(zoneId: string): Promise<ZoneConfig> {
    const config = await this.getConfig();
    const zone = config['zones'][0]['zone'].find((z) => z['id'] === zoneId);
    if (!zone) throw new Error(`Zone ${zoneId} not found in config`);
    return zone;
  }

  async getSystem(): Promise<InfinitudeSystem> {
    const [status, config] = await Promise.all([this.getStatus(), this.getConfig()]);
    return { status, config };
  }

  async getTemperatureScale(): Promise<string> {
    const config = await this.getConfig();
    return config['cfgem'][0] as unknown as string;
  }

  async getOutdoorTemperature(): Promise<number> {
    // oat is in the full status — use cache
    const status = await this.getStatus();
    const raw = (status as unknown as Record<string, unknown>)['oat'];
    if (raw !== undefined) return parseFloat(String(raw));
    // Fallback: dedicated endpoint
    const resp = await this.fetch<Record<string, unknown>>('/api/status/oat');
    const val = typeof resp === 'object' && resp !== null ? resp['oat'] ?? resp : resp;
    return parseFloat(String(val));
  }

  async getFilterLifeLevel(): Promise<number> {
    const status = await this.getStatus();
    const raw = (status as unknown as Record<string, unknown>)['filtrlvl'];
    if (raw !== undefined) return parseFloat(String(raw));
    const resp = await this.fetch<Record<string, unknown>>('/api/status/filtrlvl');
    const val = typeof resp === 'object' && resp !== null ? resp['filtrlvl'] ?? resp : resp;
    return parseFloat(String(val));
  }

  // ─── Writes (always invalidate cache) ─────────────────────────────────────

  async setTargetTemperature(
    zoneId: string,
    targetTemperature: string,
    setpoint: 'htsp' | 'clsp',
    activity: string | null,
  ): Promise<void> {
    const zone = await this.getZoneStatus(zoneId);
    const resolvedActivity = activity ?? zone?.['currentActivity']?.[0] ?? 'manual';
    await this.fetch(`/api/${zoneId}/activity/${resolvedActivity}?${setpoint}=${targetTemperature}`);
    this.invalidateCache();
  }

  async setFanSpeed(zoneId: string, activity: string, speed: string): Promise<void> {
    await this.fetch(`/api/${zoneId}/activity/${activity}?fan=${speed}`);
    this.invalidateCache();
  }

  async setActivity(zoneId: string, activity: string, until: string): Promise<void> {
    await this.fetch(`/api/${zoneId}/hold?activity=${activity}&until=${until}`);
    this.invalidateCache();
  }

  async removeHold(zoneId: string): Promise<void> {
    await this.fetch(`/api/${zoneId}/hold?hold=off`);
    this.invalidateCache();
  }

  async setSystemMode(mode: string): Promise<void> {
    const config = await this.getConfig();
    const currentMode = config['mode'][0] as unknown as string;
    if (currentMode !== mode) {
      await this.fetch(`/api/config?mode=${mode}&set_changes=true`);
      this.invalidateCache();
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
