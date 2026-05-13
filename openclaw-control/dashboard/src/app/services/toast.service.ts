import { Injectable, signal } from '@angular/core';

export interface Toast {
  id: number;
  message: string;
  type: 'success' | 'error' | 'info' | 'warning';
  duration: number;
}

@Injectable({ providedIn: 'root' })
export class ToastService {
  private nextId = 1;
  readonly queue = signal<Toast[]>([]);

  push(message: string, type: Toast['type'] = 'info', duration = 4000) {
    const id = this.nextId++;
    const toast: Toast = { id, message, type, duration };
    this.queue.update((q) => [...q, toast]);
    setTimeout(() => this.remove(id), duration);
  }

  success(message: string) { this.push(message, 'success'); }
  error(message: string) { this.push(message, 'error', 6000); }
  info(message: string) { this.push(message, 'info'); }
  warning(message: string) { this.push(message, 'warning'); }

  remove(id: number) {
    this.queue.update((q) => q.filter((t) => t.id !== id));
  }
}
