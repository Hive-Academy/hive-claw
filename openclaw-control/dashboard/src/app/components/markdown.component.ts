import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { inject } from '@angular/core';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({
  gfm: true,
  breaks: false,
});

interface ParsedSource {
  frontmatter: { key: string; value: string }[];
  body: string;
}

const FRONTMATTER_RE = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/;

function parseSource(src: string): ParsedSource {
  const m = src.match(FRONTMATTER_RE);
  if (!m) return { frontmatter: [], body: src };
  const yaml = m[1];
  const body = src.slice(m[0].length);
  const fm: { key: string; value: string }[] = [];
  for (const line of yaml.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colon = trimmed.indexOf(':');
    if (colon < 0) continue;
    const key = trimmed.slice(0, colon).trim();
    let value = trimmed.slice(colon + 1).trim();
    if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
      value = value.slice(1, -1);
    }
    if (!key) continue;
    fm.push({ key, value });
  }
  return { frontmatter: fm, body };
}

@Component({
  selector: 'oc-md',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [`
    :host details > summary { list-style: none; }
    :host details > summary::-webkit-details-marker { display: none; }
    :host details > summary .chev { transition: transform .15s ease; display: inline-block; }
    :host details[open] > summary .chev { transform: rotate(90deg); }
  `],
  template: `
    @if (parsed().frontmatter.length > 0) {
      <details class="mb-3">
        <summary class="cursor-pointer text-xs uppercase tracking-wider text-base-content/50 hover:text-base-content/80 select-none flex items-center gap-2">
          <span class="chev">▶</span>
          metadata ({{ parsed().frontmatter.length }} fields)
        </summary>
        <dl class="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs bg-base-300/40 rounded-md p-3 border border-base-300">
          @for (kv of parsed().frontmatter; track kv.key) {
            <dt class="text-base-content/60 font-mono">{{ kv.key }}</dt>
            <dd class="font-mono break-all">{{ kv.value || '—' }}</dd>
          }
        </dl>
      </details>
    }
    @if (parsed().body.trim()) {
      <div class="markdown-body" [innerHTML]="html()"></div>
    } @else if (parsed().frontmatter.length === 0) {
      <p class="text-sm text-base-content/40 italic">empty</p>
    }
  `,
})
export class MarkdownComponent {
  private sanitizer = inject(DomSanitizer);
  source = input<string>('');

  parsed = computed<ParsedSource>(() => parseSource(this.source() ?? ''));

  html = computed<SafeHtml>(() => {
    const body = this.parsed().body;
    if (!body.trim()) return this.sanitizer.bypassSecurityTrustHtml('');
    const raw = marked.parse(body, { async: false }) as string;
    const clean = DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
    return this.sanitizer.bypassSecurityTrustHtml(clean);
  });
}
