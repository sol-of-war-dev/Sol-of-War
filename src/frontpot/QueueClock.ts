/** Keep a queue's display clock moving between server polls. */
export class QueueClock {
  private id: string | null = null;
  private started = 0;
  constructor(private now = () => performance.now()) {}
  seconds(search: { id: string; elapsedSeconds: number } | null): number {
    if (!search) {
      this.id = null;
      return 0;
    }
    if (search.id !== this.id) {
      this.id = search.id;
      this.started = this.now() - search.elapsedSeconds * 1000;
    }
    return Math.max(0, Math.floor((this.now() - this.started) / 1000));
  }
}
