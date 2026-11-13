import { request } from 'node:https';

const origin = new URL(process.env.APP_ORIGIN ?? '');
const port = Number(process.env.PORT ?? 3443);

await new Promise<void>((resolve, reject) => {
  const req = request({
    hostname: '127.0.0.1', port, path: '/health/ready', method: 'GET',
    servername: process.env.TLS_ORIGIN_HOSTNAME || origin.hostname, rejectUnauthorized: true, timeout: 5_000,
  }, (response) => {
    response.resume();
    response.once('end', () => response.statusCode === 200 ? resolve() : reject(new Error(`Readiness returned ${response.statusCode}`)));
  });
  req.once('timeout', () => req.destroy(new Error('Readiness timed out')));
  req.once('error', reject);
  req.end();
});
