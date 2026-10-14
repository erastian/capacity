import { networkInterfaces } from 'node:os';

export function listenUrls(port: number, path = ''): string[] {
  const addresses = Object.values(networkInterfaces())
    .flat()
    .filter((info) => info?.family === 'IPv4' && !info.internal)
    .map((info) => info!.address);

  return ['localhost', ...addresses].map((host) => `http://${host}:${port}${path}`);
}
