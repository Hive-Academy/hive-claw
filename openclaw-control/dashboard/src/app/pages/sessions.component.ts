import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { SseService, SseEvent } from '../services/sse.service';
import { ApiService, SessionInfo, SessionTail } from '../services/api.service';
import { SkeletonComponent } from '../components/skeleton.component';
import { ToastService } from '../services/toast.service';
import { MarkdownComponent } from '../components/markdown.component';

@Component({
  selector: 'oc-sessions',
  standalone: true,
  imports: [DecimalPipe, SkeletonComponent, MarkdownComponent],
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
        Streamed from openclaw's per-agent transcripts at
        <kbd class="kbd kbd-sm">~/.openclaw/agents/&lt;agent&gt;/sessions/*.jsonl</kbd>
        in real time.
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
                    <div class="text-xs text-base-content/50 font-mono">agent: {{ s.agentId }}</div>
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
                  @let role = e.role ?? e.type ?? '';
                  @if (role === 'user') {
                    <div class="flex flex-col items-start gap-1 py-1">
                      <div class="flex items-center gap-2">
                        <span class="badge badge-ghost badge-sm">User</span>
                        @if (e.ts) {
                          <span class="text-xs text-base-content/40">{{ formatTs(e.ts) }}</span>
                        }
                      </div>
                      <div class="bg-base-300 rounded p-2 text-sm max-w-[90%] whitespace-pre-wrap">{{ e.preview ?? '' }}</div>
                    </div>
                  } @else if (role === 'assistant') {
                    <div class="flex flex-col items-end gap-1 py-1">
                      <div class="flex items-center gap-2">
                        @if (e.ts) {
                          <span class="text-xs text-base-content/40">{{ formatTs(e.ts) }}</span>
                        }
                        <span class="badge badge-primary badge-sm">Assistant</span>
                      </div>
                      <div class="bg-primary/10 border border-primary/20 rounded p-2 max-w-[90%]">
                        @if (e.preview && !e.preview.startsWith('[tool:')) {
                          <oc-md [source]="e.preview" />
                        } @else if (e.preview?.startsWith('[tool:')) {
                          <span class="font-mono text-xs text-base-content/60">{{ e.preview }}</span>
                        } @else {
                          <span class="text-base-content/30 text-xs italic">no text content</span>
                        }
                      </div>
                    </div>
                  } @else if (isToolRole(role)) {
                    <details class="text-xs py-1">
                      <summary class="cursor-pointer flex items-center gap-2 p-1 hover:bg-base-300 rounded select-none">
                        <span class="badge badge-ghost badge-xs">{{ role === 'tool_use' || role === 'tool' ? 'Tool call' : 'Tool result' }}</span>
                        <span class="font-mono text-base-content/70">{{ toolLabel(e) }}</span>
                        @if (e.ts) {
                          <span class="text-base-content/40 ml-auto">{{ formatTs(e.ts) }}</span>
                        }
                      </summary>
                      <pre class="font-mono bg-base-300 rounded p-2 mt-1 overflow-x-auto whitespace-pre-wrap break-all text-xs">{{ stringify(e.raw) }}</pre>
                    </details>
                  } @else {
                    <details class="text-xs py-1">
                      <summary class="cursor-pointer text-base-content/40 select-none">{{ role || 'event' }} ({{ e.type ?? 'unknown' }})</summary>
                      <pre class="font-mono bg-base-300 rounded p-2 mt-1 overflow-x-auto whitespace-pre-wrap break-all text-xs">{{ stringify(e.raw) }}</pre>
                    </details>
                  }
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
      s.agentId.toLowerCase().includes(q),
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
    this.api.tailSession(s.agentId, 100).subscribe({
      next: (t) => this.tail.set(t),
      error: (err) => this.toast.error(err?.error?.error || 'Failed to load session tail'),
    });
  }

  clearSelection() {
    this.selected.set(null);
    this.tail.set(null);
  }

  isToolRole(role: string): boolean {
    return role === 'tool' || role === 'tool_use' || role === 'tool_result' || role === 'toolResult';
  }

  toolLabel(e: any): string {
    // openclaw format: raw.message.toolName
    // Claude Code format: raw.message.content[].type==='tool_use' .name
    const msg = e.raw?.message;
    if (msg?.toolName) return msg.toolName;
    if (Array.isArray(msg?.content)) {
      const tu = msg.content.find((c: any) => c?.type === 'tool_use');
      if (tu?.name) return tu.name;
    }
    return msg?.toolCallId ?? 'tool';
  }

  stringify(e: unknown): string {
    try {
      return JSON.stringify(e, null, 2);
    } catch {
      return String(e);
    }
  }

  formatTs(ts: string | number): string {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return String(ts);
    const diffMs = Date.now() - d.getTime();
    if (diffMs < 60_000) return `${Math.floor(diffMs / 1000)}s ago`;
    if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
    return d.toLocaleTimeString();
  }
}
