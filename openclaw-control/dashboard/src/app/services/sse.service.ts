import { Injectable, NgZone, inject, signal } from '@angular/core';

export interface SseEvent {
  type: string;
  data: any;
  ts: number;
}

@Injectable({ providedIn: 'root' })
export class SseService {
  private zone = inject(NgZone);
  private es: EventSource | null = null;
  private buffer: SseEvent[] = [];
  readonly events = signal<SseEvent[]>([]);
  readonly connected = signal(false);

  connect(): void {
    if (this.es) return;
    const es = new EventSource('/api/stream', { withCredentials: true } as any);
    this.es = es;
    const types = [
      'task.updated',
      'task.created',
      'agent.updated',
      'agent.handoff',
      'session.message',
      'invoker.started',
      'invoker.stdout',
      'invoker.finished',
      'continuation.tick',
      'checkpoint.pending',
      'checkpoint.approved',
      // TASK_2026_006 Batch 8d: extension install lifecycle (amendment §16.3).
      // Driven by the installWorker + approve/reject routes; consumed by the
      // Extensions page service (`ExtensionsService`).
      'installs.requested',
      'installs.approved',
      'installs.rejected',
      'installs.applied',
      'installs.failed',
    ];
    es.onopen = () => this.zone.run(() => this.connected.set(true));
    es.onerror = () => this.zone.run(() => this.connected.set(false));
    for (const t of types) {
      es.addEventListener(t, (e) => {
        try {
          const data = JSON.parse((e as MessageEvent).data);
          const evt: SseEvent = { type: t, data, ts: Date.now() };
          this.zone.run(() => {
            this.buffer = [evt, ...this.buffer].slice(0, 200);
            this.events.set(this.buffer);
          });
        } catch {}
      });
    }
  }

  disconnect(): void {
    this.es?.close();
    this.es = null;
    this.connected.set(false);
  }
}
