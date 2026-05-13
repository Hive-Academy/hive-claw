import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { SseService, SseEvent } from '../services/sse.service';
import { ApiService, SessionInfo, SessionTail } from '../services/api.service';
import { SkeletonComponent } from '../components/skeleton.component';
import { ToastService } from '../services/toast.service';

@Component({
  selector: 'oc-sessions',
  standalone: true,
  imports: [DecimalPipe, SkeletonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="space-y-4">
      <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <h1 class="text-2xl font-bold">Live sessions</h1>
        <div class="flex gap-2">
          <input
            type="text"
            placeholder="Filter sessions..."
            class="input input-sm input-bordered w-full sm:w-56"
            [value]="query()"
            (input)="query.set($any($event.target).value)"
          />
          <button class="btn btn-sm btn-outline" (click)="refresh()">Refresh</button>
        </div>
      </div>

      <p class="text-sm text-base-content/60">
        Streamed from all <kbd class="kbd kbd-sm">~/.claude/projects/&lt;project&gt;/*.jsonl</kbd> files in real time.
      </p>

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div class="card bg-base-200 border border-base-300">
          <div class="card-body p-4">
            <div class="flex items-center justify-between mb-2">
              <h2 class="card-title text-base">Sessions</h2>
              <span class="badge badge-ghost badge-sm">{{ filtered().length }}</span>
            </div>
            @if (loading()) {
              <div class="space-y-2">
                @for (i of [1,2,3,4]; track i) {
                  <div class="p-2 rounded bg-base-300/50 space-y-2">
                    <oc-skeleton cls="h-3 w-1/3" />
                    <oc-skeleton cls="h-4 w-full" />
                    <oc-skeleton cls="h-3 w-1/2" />
                  </div>
                }
              </div>
            } @else if (filtered().length === 0) {
              <p class="text-sm text-base-content/50">No sessions found.</p>
            } @else {
              <div class="space-y-2 max-h-[70vh] overflow-y-auto pr-1">
                @for (s of filtered(); track s.sessionId) {
                  <button
                    class="w-full text-left p-2 rounded hover:bg-base-300 transition-colors"
                    [class.bg-base-300]="selected()?.sessionId === s.sessionId"
                    (click)="select(s)"
                  >
                    <div class="text-xs text-base-content/50 font-mono">{{ s.projectKey }}</div>
                    <div class="text-sm font-mono break-all">{{ s.sessionId }}</div>
                    <div class="text-xs text-base-content/40 mt-1">
                      {{ s.mtime }} · {{ (s.size / 1024) | number:'1.0-1' }} KB
                    </div>
                  </button>
                }
              </div>
            }
          </div>
        </div>

        <div class="card bg-base-200 border border-base-300">
          <div class="card-body p-4">
            <div class="flex items-center justify-between mb-2">
              <h2 class="card-title text-base">Tail / Live feed</h2>
              @if (tail(); as t) {
                <span class="badge badge-ghost badge-sm">{{ t.events.length }} events</span>
              } @else {
                <span class="badge badge-ghost badge-sm">{{ liveEvents().length }} live</span>
              }
            </div>

            @if (tail(); as t) {
              <div class="flex items-center justify-between mb-2 text-xs">
                <span class="font-mono text-base-content/60 break-all">{{ t.session.sessionId }}</span>
                <button class="btn btn-xs btn-ghost" (click)="clearSelection()">Live feed</button>
              </div>
              <div class="space-y-1 max-h-[70vh] overflow-y-auto pr-1">
                @for (e of t.events; track $index) {
                  <pre class="text-xs font-mono bg-base-300 rounded p-2 break-all whitespace-pre-wrap overflow-x-auto">{{ stringify(e) }}</pre>
                }
                @if (t.events.length === 0) {
                  <p class="text-sm text-base-content/50">No events in this session yet.</p>
                }
              </div>
            } @else {
              <div class="space-y-1 max-h-[70vh] overflow-y-auto pr-1">
                @for (e of liveEvents(); track e.ts) {
                  <div class="bg-base-300 rounded p-2">
                    <div class="flex gap-2 items-center flex-wrap">
                      <span class="badge badge-sm badge-outline">{{ e.data?.event?.role || e.type }}</span>
                      <span class="text-xs text-base-content/50 font-mono">{{ e.data?.sessionId?.slice(0, 8) }}</span>
                      <span class="text-xs text-base-content/40 ml-auto">{{ e.ts }}</span>
                    </div>
                    @if (e.data?.event?.preview) {
                      <div class="mt-1 text-sm text-base-content/80">{{ e.data.event.preview }}</div>
                    }
                  </div>
                }
                @if (liveEvents().length === 0) {
                  <p class="text-sm text-base-content/50">Waiting for live events… or pick a session on the left to view its tail.</p>
                }
              </div>
            }
          </div>
        </div>
      </div>
    </div>
  `,
})
export class SessionsComponent implements OnInit, OnDestroy {
  private api = inject(ApiService);
  private sse = inject(SseService);
  private toast = inject(ToastService);

  sessions = signal<SessionInfo[]>([]);
  loading = signal(true);
  query = signal('');
  selected = signal<SessionInfo | null>(null);
  tail = signal<SessionTail | null>(null);

  private timer: ReturnType<typeof setInterval> | null = null;

  filtered = computed(() => {
    const q = this.query().toLowerCase().trim();
    const list = this.sessions();
    if (!q) return list;
    return list.filter((s) =>
      s.sessionId.toLowerCase().includes(q) ||
      s.projectKey.toLowerCase().includes(q),
    );
  });

  liveEvents = computed<SseEvent[]>(() =>
    this.sse.events().filter((e) => e.type === 'session.message').slice(0, 50),
  );

  ngOnInit() {
    this.refresh();
    this.timer = setInterval(() => this.refresh(), 10_000);
  }

  ngOnDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  refresh() {
    this.api.sessions().subscribe({
      next: (s) => {
        this.sessions.set(s.slice(0, 50));
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  select(s: SessionInfo) {
    this.selected.set(s);
    this.tail.set(null);
    this.api.tailSession(s.projectKey, 100).subscribe({
      next: (t) => this.tail.set(t),
      error: (err) => this.toast.error(err?.error?.error || 'Failed to load session tail'),
    });
  }

  clearSelection() {
    this.selected.set(null);
    this.tail.set(null);
  }

  stringify(e: unknown): string {
    try {
      return JSON.stringify(e, null, 2);
    } catch {
      return String(e);
    }
  }
}
