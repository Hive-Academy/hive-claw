import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { SseService, SseEvent } from '../services/sse.service';
import { ApiService } from '../services/api.service';

@Component({
  selector: 'oc-sessions',
  standalone: true,
  imports: [DecimalPipe],
  template: `
    <h1 style="margin:0 0 1rem">Live sessions</h1>
    <div class="muted" style="margin-bottom:1rem">
      Streamed from all <span class="kbd">~/.claude/projects/&lt;project&gt;/*.jsonl</span> files in real time.
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem">
      <div>
        <h3 style="margin:.25rem 0">Sessions</h3>
        @for (s of sessions(); track s.sessionId) {
          <div class="card" style="margin-bottom:.5rem">
            <div style="font-size:11px" class="muted">{{ s.projectKey }}</div>
            <div style="word-break:break-all">{{ s.sessionId }}</div>
            <div class="muted" style="font-size:11px">{{ s.mtime }} · {{ (s.size / 1024) | number:'1.0-1' }} KB</div>
          </div>
        }
      </div>
      <div>
        <h3 style="margin:.25rem 0">Live event feed</h3>
        @for (e of sessionEvents(); track e.ts) {
          <div class="card" style="margin-bottom:.5rem;padding:.5rem .75rem">
            <div style="display:flex;gap:.5rem;align-items:center">
              <span class="tag">{{ e.data?.event?.role || e.type }}</span>
              <span class="muted" style="font-size:11px">{{ e.data?.sessionId?.slice(0,8) }}</span>
            </div>
            @if (e.data?.event?.preview) { <div style="margin-top:.25rem;font-size:13px">{{ e.data.event.preview }}</div> }
          </div>
        }
      </div>
    </div>
  `,
  styles: [`:host ::ng-deep number {}`],
})
export class SessionsComponent implements OnInit, OnDestroy {
  private api = inject(ApiService);
  private sse = inject(SseService);
  sessions = signal<any[]>([]);
  private timer: any;

  ngOnInit() {
    this.refresh();
    this.timer = setInterval(() => this.refresh(), 10_000);
  }
  ngOnDestroy() { clearInterval(this.timer); }
  refresh() { this.api.sessions().subscribe((s) => this.sessions.set(s.slice(0, 30))); }
  sessionEvents(): SseEvent[] {
    return this.sse.events().filter((e) => e.type === 'session.message').slice(0, 30);
  }
}
