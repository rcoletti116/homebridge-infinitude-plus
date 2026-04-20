const { HomebridgePluginUiServer, RequestError } = require('@homebridge/plugin-ui-utils');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const os = require('os');

class InfinitudeUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();

    // ── /hostinfo — returns the server's LAN IP ───────────────────
    this.onRequest('/hostinfo', async () => {
      const lanIp = getLanIp();
      return { lanIp };
    });

    // ── /status — checks if an Infinitude instance is reachable ──
    this.onRequest('/status', async (body) => {
      const urlStr = body && body.url;
      if (!urlStr || typeof urlStr !== 'string') {
        throw new RequestError('Missing or invalid url parameter', { status: 400 });
      }

      return new Promise((resolve, reject) => {
        let parsed;
        try {
          parsed = new URL(urlStr);
        } catch (_) {
          return reject(new RequestError('Invalid URL', { status: 400 }));
        }

        const transport = parsed.protocol === 'https:' ? https : http;

        const req = transport.get(urlStr, { timeout: 4000 }, (res) => {
          res.resume();
          resolve({ online: true, status: res.statusCode });
        });

        req.on('timeout', () => {
          req.destroy();
          reject(new RequestError('Timeout', { status: 504 }));
        });

        req.on('error', (err) => {
          reject(new RequestError(err.message, { status: 503 }));
        });
      });
    });

    this.ready();
  }
}

/**
 * Return the first non-loopback IPv4 address found on any interface.
 * Falls back to '127.0.0.1' if none is found.
 */
function getLanIp() {
  const interfaces = os.networkInterfaces();
  for (const iface of Object.values(interfaces)) {
    for (const entry of iface || []) {
      if (entry.family === 'IPv4' && !entry.internal) {
        return entry.address;
      }
    }
  }
  return '127.0.0.1';
}

(() => new InfinitudeUiServer())();
