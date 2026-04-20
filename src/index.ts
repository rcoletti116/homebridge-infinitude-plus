import { API } from 'homebridge';
import { InfinitudePlatform } from './InfinitudePlatform';
import { PLUGIN_NAME, PLATFORM_NAME } from './types';

/**
 * Plugin entry point.
 *
 * Homebridge calls this function with its API instance when the plugin is
 * loaded. We register our platform class and that's it — the rest is driven
 * by the Homebridge lifecycle.
 */
export default (api: API): void => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, InfinitudePlatform);
};
