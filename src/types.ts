export interface AdvancedDetails {
  manufacturer?: string;
  model?: string;
  serial?: string;
}

export interface ThermostatConfig {
  name: string;
  url: string;
  externalUrl?: string;
  advancedDetails?: AdvancedDetails;
  holdUntil?: string;
  shutOffAway?: boolean;
  holdUntilNextActivity?: boolean;
  useFan?: boolean;
  useOutdoorTemperatureSensor?: boolean;
  sensorpoll?: number;
}

export interface PlatformConfig {
  name?: string;
  thermostats?: ThermostatConfig[];
  verbose?: boolean;
}

// Infinitude API response shapes

export interface ZonePeriod {
  time: [string];
  enabled: [string];
  activity: [string];
}

export interface ZoneDay {
  period: ZonePeriod[];
}

export interface ZoneActivity {
  id: string;
  fan: [string];
  htsp: [string];
  clsp: [string];
}

export interface ZoneConfig {
  id: string;
  name: string;
  enabled: [string];
  program: [{ day: ZoneDay[] }];
  activities: [{ activity: ZoneActivity[] }];
}

export interface ZoneStatus {
  id: string;
  name: string;
  enabled: [string];
  currentActivity: [string];
  zoneconditioning: [string];
  hold: [string];
  fan: [string];
  rt: [string];
  rh: [string];
  htsp: [string];
  clsp: [string];
}

export interface SystemStatus {
  localTime: [string];
  zones: [{ zone: ZoneStatus[] }];
  oat: string;
}

export interface SystemConfig {
  mode: [string];
  cfgem: [string];
  zones: [{ zone: ZoneConfig[] }];
}

export interface InfinitudeSystem {
  status: SystemStatus;
  config: SystemConfig;
}

export const PLUGIN_NAME = 'homebridge-infinitude-plus';
export const PLATFORM_NAME = 'InfinitudePlatform';

export const MIN_COOL_C = 10;
export const MAX_COOL_C = 35;
export const MIN_HEAT_C = 0;
export const MAX_HEAT_C = 25;

export const DEFAULT_SENSOR_POLL_MS = 120_000;
export const CLIENT_TIMEOUT_MS = 5_000;
export const INIT_DELAY_MS = 5_000;

// ─── Fakegato ──────────────────────────────────────────────────────────────

/**
 * Minimal typing for the fakegato-history service (v0.6.x+).
 * The module has no official TypeScript types so we declare what we use.
 *
 * v0.6.x changed the API:
 *   - Use `import fakegato from 'fakegato-history'` (ESM default export)
 *   - FakeGatoHistoryService is constructed with (type, accessory, options)
 *   - The accessory must have a `.log` property
 */
export interface FakeGatoHistoryService {
  addEntry(entry: Record<string, number>): void;
}

export type FakeGatoHistoryServiceConstructor = new (
  type: string,
  accessory: FakeGatoAccessory,
  options?: { size?: number; storage?: string; path?: string },
) => FakeGatoHistoryService;

export interface FakeGatoAccessory {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  log: any;
  displayName: string;
  services: unknown[];
}

// v0.6.x exports a default function that takes the homebridge API
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type FakeGatoFactory = (api: any) => FakeGatoHistoryServiceConstructor;
