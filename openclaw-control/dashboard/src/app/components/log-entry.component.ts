import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

interface ParsedEvent {
  badge: string;
  badgeClass: string;
  summary: string;
  detail?: string;
  payload?: unknown;
}

const TYPE_BADGE: Record<string, string> = {
  'invoker.started': 'badge-info',
  'invoker.finished': 'badge-success',
  'invoker.failed': 'badge-error',
  'invoker.stdout': 'badge-ghost',
  'invoker.stderr': 'badge-warning',
  'dispatch.pending': 'badge-warning',
  'dispatch.taken': 'badge-accent',
  'dispatch.done': 'badge-success',
  'dispatch.failed': 'badge-error',
  'task.created': 'badge-info',
  'task.complete': 'badge-success',
  'task.phase': 'badge-secondary',
  'session.message': 'badge-ghost',
  'session.created': 'badge-info',
};

function parseEvent(type: string, data: any): ParsedEvent {
  const badgeClass = TYPE_BADGE[type] ?? 'badge-ghost';
  const shortType = type.split('.').slice(-1)[0] ?? type;

  if (type === 'invoker.stdout' || type === 'invoker.stderr') {
    const chunk = data?.chunk;
    if (typeof chunk === 'string') {
      const parsed = tryParseJson(chunk);
      if (parsed && typeof parsed === 'object') {
        const summary = formatJsonRpc(parsed);
        return { badge: shortType, badgeClass, summary, payload: parsed };
      }
      return { badge: shortType, badgeClass, summary: chunk.trim(), payload: chunk };
    }
    return { badge: shortType, badgeClass, summary: '(no chunk)', payload: data };
  }

  if (type === 'invoker.started') {
    return {
      badge: 'started',
      badgeClass,
      summary: `agent ${data?.agentId ?? '?'} → ${data?.taskId ?? '?'}`,
      payload: data,
    };
  }

  if (type === 'invoker.finished' || type === 'invoker.failed') {
    const ok = data?.ok ? 'ok' : 'fail';
    const exit = data?.exitCode ?? '?';
    const dur = data?.durationMs ? ` ${(data.durationMs / 1000).toFixed(1)}s` : '';
    return {
      badge: shortType,
      badgeClass,
      summary: `${ok} · exit ${exit}${dur}`,
      payload: data,
    };
  }

  if (type.startsWith('dispatch.')) {
    return {
      badge: shortType,
      badgeClass,
      summary: `${data?.agentId ?? '?'} · ${data?.taskId ?? data?.dispatchId ?? '?'} · ${data?.phase ?? ''}`,
      payload: data,
    };
  }

  if (type.startsWith('task.')) {
    return {
      badge: shortType,
      badgeClass,
      summary: `${data?.taskId ?? '?'} · ${data?.phase ?? data?.message ?? ''}`,
      payload: data,
    };
  }

  if (type === 'session.message') {
    const role = data?.event?.role ?? '?';
    const preview = data?.event?.preview ?? '';
    return {
      badge: role,
      badgeClass: role === 'assistant' ? 'badge-primary' : role === 'user' ? 'badge-info' : 'badge-ghost',
      summary: preview || '(no preview)',
      payload: data,
    };
  }

  return { badge: shortType, badgeClass, summary: shortPreview(data), payload: data };
}

function tryParseJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}

function formatJsonRpc(parsed: any): string {
  if (parsed?.method === 'agent.message') {
    const text = (parsed.params?.text ?? '').toString().trim();
    if (text) return `agent.message · ${truncate(text, 240)}`;
    return 'agent.message · (empty)';
  }
  if (parsed?.method === 'session.created') {
    return `session.created · ${shortId(parsed.params?.session_id)}`;
  }
  if (parsed?.method === 'task.complete') {
    const cmd = parsed.params?.command;
    const dur = parsed.params?.duration_ms;
    const sid = parsed.params?.summary?.session_id;
    return `task.complete · ${cmd ?? ''}${dur ? ` ${(dur / 1000).toFixed(1)}s` : ''}${sid ? ` · ${shortId(sid)}` : ''}`;
  }
  if (parsed?.method) {
    return `${parsed.method}${parsed.params?.session_id ? ` · ${shortId(parsed.params.session_id)}` : ''}`;
  }
  if (parsed?.result !== undefined) {
    return `result · ${shortPreview(parsed.result)}`;
  }
  return shortPreview(parsed);
}

function shortPreview(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return truncate(v, 240);
  try { return truncate(JSON.stringify(v), 240); } catch { return String(v); }
}

function shortId(id: unknown): string {
  if (typeof id !== 'string') return '';
  return id.slice(0, 8);
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + '…';
}

@Component({
  selector: 'oc-log-entry',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    :host details > summary { list-style: none; }
    :host details > summary::-webkit-details-marker { display: none; }
  `],
  template: `
    <details class="border-l-2 border-base-300 hover:border-primary/40 transition-colors">
      <summary class="cursor-pointer px-3 py-1.5 flex items-start gap-3 hover:bg-base-300/30 rounded-r">
        <span class="text-xs text-base-content/40 font-mono shrink-0 w-20 mt-0.5">{{ time() }}</span>
        <span class="badge badge-xs shrink-0 mt-0.5" [class]="parsed().badgeClass">{{ parsed().badge }}</span>
        <span class="text-sm text-base-content/80 break-all flex-1 min-w-0">{{ parsed().summary }}</span>
      </summary>
      <div class="px-3 pb-2 pl-[7.5rem]">
        <pre class="text-xs bg-base-300 rounded p-2 overflow-x-auto whitespace-pre-wrap break-all">{{ raw() }}</pre>
      </div>
    </details>
  `,
})
export class LogEntryComponent {
  type = input.required<string>();
  data = input<any>();
  ts = input<number>(0);

  parsed = computed<ParsedEvent>(() => parseEvent(this.type(), this.data()));

  time = computed(() => {
    const ts = this.ts();
    if (!ts) return '';
    try { return new Date(ts).toLocaleTimeString(); } catch { return ''; }
  });

  raw = computed(() => {
    const p = this.parsed().payload;
    try { return JSON.stringify(p, null, 2); } catch { return String(p); }
  });
}
