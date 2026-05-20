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

      <!-- Sidebar + messages: narrow fixed sidebar, wide chat area -->
      <div class="flex gap-3 min-h-0" style="height: calc(100vh - 160px)">

        <!-- Sidebar -->
        <div class="w-56 shrink-0 flex flex-col card bg-base-200 border border-base-300 overflow-hidden">
          <div class="flex items-center justify-between px-3 pt-3 pb-2 border-b border-base-300">
            <span class="text-sm font-semibold">Sessions</span>
            <span class="badge badge-ghost badge-sm">{{ filtered().length }}</span>
          </div>
          @if (loading()) {
            <div class="p-3 space-y-3">
              @for (i of [1,2,3,4]; track i) {
                <div class="space-y-1.5">
                  <oc-skeleton cls="h-3 w-1/2" />
                  <oc-skeleton cls="h-3 w-3/4" />
                </div>
              }
            </div>
          } @else if (filtered().length === 0) {
            <p class="text-xs text-base-content/50 p-3">No sessions found.</p>
          } @else {
            <div class="flex-1 overflow-y-auto">
              @for (s of filtered(); track s.sessionId) {
                <button
                  class="w-full text-left px-3 py-2.5 border-b border-base-300/50 hover:bg-base-300 transition-colors"
                  [class.bg-base-300]="selected()?.sessionId === s.sessionId"
                  [class.border-l-2]="selected()?.sessionId === s.sessionId"
                  [class.border-l-primary]="selected()?.sessionId === s.sessionId"
                  (click)="select(s)"
                >
                  <div class="flex items-center gap-1.5 mb-0.5">
                    <span class="badge badge-xs {{ s.agentId === 'anubis' ? 'badge-primary' : 'badge-secondary' }}">{{ s.agentId }}</span>
                  </div>
                  <div class="text-xs font-mono text-base-content/60">{{ s.sessionId.slice(0, 8) }}…</div>
                  <div class="text-xs text-base-content/40 mt-0.5">{{ formatTs(s.mtime) }} · {{ (s.size / 1024) | number:'1.0-1' }} KB</div>
                </button>
              }
            </div>
          }
        </div>

        <!-- Messages area -->
        <div class="flex-1 min-w-0 flex flex-col card bg-base-200 border border-base-300 overflow-hidden">
          <div class="flex items-center justify-between px-4 py-3 border-b border-base-300 shrink-0">
            @if (tail(); as t) {
              <div class="flex items-center gap-2 min-w-0">
                <span class="badge badge-xs {{ t.session.agentId === 'anubis' ? 'badge-primary' : 'badge-secondary' }}">{{ t.session.agentId }}</span>
                <span class="text-xs font-mono text-base-content/50 truncate">{{ t.session.sessionId.slice(0, 16) }}…</span>
                <span class="badge badge-ghost badge-xs">{{ t.events.length }} events</span>
              </div>
              <button class="btn btn-xs btn-ghost shrink-0" (click)="clearSelection()">← All sessions</button>
            } @else {
              <span class="text-sm font-semibold text-base-content/60">Live feed</span>
              <span class="badge badge-ghost badge-sm">{{ liveEvents().length }} live</span>
            }
          </div>

          <div class="flex-1 overflow-y-auto px-4 py-3 space-y-2">
            @if (tail(); as t) {
              @for (e of t.events; track $index) {
                @let role = e.role ?? e.type ?? '';
                @if (role === 'user') {
                  <div class="flex flex-col items-start gap-1">
                    <div class="flex items-center gap-2">
                      <span class="badge badge-ghost badge-xs">User</span>
                      @if (e.ts) { <span class="text-xs text-base-content/40">{{ formatTs(e.ts) }}</span> }
                    </div>
                    <div class="bg-base-300 rounded-lg rounded-tl-none px-3 py-2 text-sm max-w-[85%] whitespace-pre-wrap">{{ e.preview ?? '' }}</div>
                  </div>
                } @else if (role === 'assistant') {
                  <div class="flex flex-col items-end gap-1">
                    <div class="flex items-center gap-2">
                      @if (e.ts) { <span class="text-xs text-base-content/40">{{ formatTs(e.ts) }}</span> }
                      <span class="badge badge-primary badge-xs">Assistant</span>
                    </div>
                    <div class="bg-primary/10 border border-primary/20 rounded-lg rounded-tr-none px-3 py-2 max-w-[85%] text-sm">
                      @if (e.preview && !e.preview.startsWith('[tool:')) {
                        <oc-md [source]="e.preview" />
                      } @else if (e.preview?.startsWith('[tool:')) {
                        <span class="font-mono text-xs text-base-content/50">{{ e.preview }}</span>
                      } @else {
                        <span class="text-base-content/30 text-xs italic">…</span>
                      }
                    </div>
                  </div>
                } @else if (isToolRole(role)) {
                  <details class="text-xs">
                    <summary class="cursor-pointer flex items-center gap-2 px-2 py-1 rounded bg-base-300/60 hover:bg-base-300 select-none">
                      <span class="badge badge-ghost badge-xs">{{ role === 'tool_use' || role === 'tool' ? 'Tool call' : 'Tool result' }}</span>
                      <span class="font-mono text-base-content/70 truncate">{{ toolLabel(e) }}</span>
                      @if (e.ts) { <span class="text-base-content/40 ml-auto shrink-0">{{ formatTs(e.ts) }}</span> }
                    </summary>
                    <pre class="font-mono bg-base-300 rounded p-2 mt-1 overflow-x-auto whitespace-pre-wrap text-xs">{{ stringify(e.raw) }}</pre>
                  </details>
                } @else {
                  <!-- System events: compact one-liner, no JSON dump -->
                  @let sys = systemEvent(e);
                  @if (sys) {
                    <div class="flex items-center gap-2 text-xs text-base-content/40 py-0.5">
                      <span class="w-1 h-1 rounded-full bg-base-content/20 shrink-0"></span>
                      <span class="font-mono">{{ sys }}</span>
                    </div>
                  }
                }
              }
              @if (t.events.length === 0) {
                <p class="text-sm text-base-content/50 text-center py-8">No events in this session yet.</p>
              }
            } @else {
              @for (e of liveEvents(); track e.ts) {
                <div class="bg-base-300/60 rounded px-3 py-2">
                  <div class="flex gap-2 items-center flex-wrap">
                    <span class="badge badge-xs badge-outline">{{ e.data?.event?.role || e.type }}</span>
                    <span class="text-xs text-base-content/50 font-mono">{{ e.data?.sessionId?.slice(0, 8) }}</span>
                    <span class="text-xs text-base-content/40 ml-auto">{{ e.ts }}</span>
                  </div>
                  @if (e.data?.event?.preview) {
                    <div class="mt-1 text-sm text-base-content/80">{{ e.data.event.preview }}</div>
                  }
                </div>
              }
              @if (liveEvents().length === 0) {
                <p class="text-sm text-base-content/50 text-center py-8">Waiting for live events… or pick a session on the left.</p>
              }
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

  systemEvent(e: any): string | null {
    const raw = e.raw ?? {};
    const type = raw.type ?? e.type ?? '';
    switch (type) {
      case 'model_change':
        return `model → ${raw.modelId ?? '?'} (${raw.provider ?? '?'})`;
      case 'thinking_level_change':
        return `thinking → ${raw.thinkingLevel ?? '?'}`;
      case 'custom': {
        const ct = raw.customType ?? raw.data?.type ?? '?';
        if (ct === 'model-snapshot') {
          const d = raw.data ?? {};
          return `snapshot: ${d.modelId ?? '?'} via ${d.modelApi ?? '?'}`;
        }
        return `custom: ${ct}`;
      }
      case 'queue-operation':
        return `queue: ${raw.operation ?? '?'}`;
      case 'ai-title':
        return `title: ${raw.title ?? '?'}`;
      case 'attachment':
        return `attachment: ${raw.fileName ?? raw.attachmentType ?? '?'}`;
      case 'file-history-snapshot':
      case 'last-prompt':
        return null; // skip — noisy internal state
      default:
        return type ? `${type}` : null;
    }
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
