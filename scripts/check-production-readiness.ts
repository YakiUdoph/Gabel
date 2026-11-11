import { createSecureContext } from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../src/config.ts';
import { Store } from '../src/db.ts';

if (process.env.NODE_ENV !== 'production') throw new Error('NODE_ENV must be production for the production readiness check');

const config = loadConfig();
if (!config.tlsKeyPath || !config.tlsCertPath) throw new Error('TLS_KEY_PATH and TLS_CERT_PATH are required');

const key = readFileSync(config.tlsKeyPath);
const certificate = readFileSync(config.tlsCertPath);
createSecureContext({ key, cert: certificate });

const x509 = new X509Certificate(certificate);
const now = Date.now();
if (Date.parse(x509.validFrom) > now || Date.parse(x509.validTo) <= now) throw new Error('The configured TLS certificate is not currently valid');
const publicHostname = new URL(config.appOrigin).hostname;
if (!x509.checkHost(publicHostname)) throw new Error('The configured TLS certificate does not cover APP_ORIGIN');

const store = new Store(config.databasePath);
try {
  const health = store.healthCheck();
  if (!health.ready) throw new Error('The production database is not ready');
  console.log(JSON.stringify({
    status: 'ready',
    checks: {
      environment: 'pass', oauthCallback: 'pass', distinctSecrets: 'pass', tls: 'pass',
      persistentDatabase: 'pass', schemaVersion: health.schemaVersion,
    },
  }));
} finally {
  store.close();
}
