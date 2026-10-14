import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { collectDefaultMetrics, Registry } from 'prom-client';
import type { Env } from '../config/env.js';
import { listenUrls } from '../shared/http/listen-urls.js';

@Injectable()
export class MetricsServer
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  readonly registry = new Registry();
  private readonly logger = new Logger(MetricsServer.name);
  private server?: Server;

  constructor(private readonly config: ConfigService<Env, true>) {
    collectDefaultMetrics({ register: this.registry });
  }

  get port(): number | undefined {
    return (this.server?.address() as AddressInfo | null)?.port;
  }

  async onApplicationBootstrap(): Promise<void> {
    this.server = createServer((req, res) => {
      if (req.method !== 'GET' || req.url !== '/metrics') {
        res.writeHead(404).end();
        return;
      }
      this.registry
        .metrics()
        .then((body) => {
          res.writeHead(200, { 'content-type': this.registry.contentType });
          res.end(body);
        })
        .catch((error: unknown) => {
          this.logger.error(error);
          res.writeHead(500).end();
        });
    });

    const port = this.config.get('METRICS_PORT', { infer: true });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject).listen(port, '0.0.0.0', () => {
        this.server!.off('error', reject);
        resolve();
      });
    });
    this.server.on('error', (error) => this.logger.error(error));
    this.logger.log(
      `Metrics listening on ${listenUrls(this.port!, '/metrics').join(', ')}`,
    );
  }

  async onApplicationShutdown(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
  }
}