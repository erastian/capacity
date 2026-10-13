import 'vitest';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrls: {
      app: string;
      maintenance: string;
      migrator: string;
    };
  }
}