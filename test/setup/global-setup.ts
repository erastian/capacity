import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { TestProject } from 'vitest/node';
import './vitest.types.js';

const PASSWORDS = {
  CAPACITY_MIGRATOR_PASSWORD: 'capacity_migrator',
  CAPACITY_APP_PASSWORD: 'capacity_app',
  CAPACITY_MAINTENANCE_PASSWORD: 'capacity_maintenance',
};

let container: StartedPostgreSqlContainer | undefined;

export async function setup(project: TestProject): Promise<void> {
  container = await new PostgreSqlContainer('postgres:17')
    .withUsername('postgres')
    .withPassword('postgres')
    .withDatabase('postgres')
    .withEnvironment(PASSWORDS)
    .withCopyFilesToContainer([
      {
        source: resolve('docker/postgres/init/01-roles.sh'),
        target: '/docker-entrypoint-initdb.d/01-roles.sh',
        mode: 0o755,
      },
    ])
    .start();

  const url = (user: string) =>
    `postgresql://${user}:${user}@${container!.getHost()}:${container!.getPort()}/capacity`;

  const databaseUrls = {
    app: url('capacity_app'),
    maintenance: url('capacity_maintenance'),
    migrator: url('capacity_migrator'),
  };

  const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
  execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    env: { ...process.env, MIGRATION_DATABASE_URL: databaseUrls.migrator },
    stdio: 'pipe',
  });

  project.provide('databaseUrls', databaseUrls);
}

export async function teardown(): Promise<void> {
  await container?.stop();
}