export class Periodic {
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;

  constructor(
    private readonly task: () => Promise<unknown>,
    private readonly onError: (error: unknown) => void,
  ) {}

  start(intervalMs: number): void {
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = this.task()
        .then(() => undefined)
        .catch(this.onError)
        .finally(() => {
          this.running = undefined;
        });
    }, intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    await this.running;
  }
}
