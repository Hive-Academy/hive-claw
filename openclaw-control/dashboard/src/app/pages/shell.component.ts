import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { ApiService } from '../services/api.service';
import { SseService } from '../services/sse.service';

@Component({
  selector: 'oc-shell',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  template: `
    <div style="display:grid;grid-template-columns:220px 1fr;min-height:100vh;">
      <aside style="background:var(--panel);border-right:1px solid var(--border);padding:1rem;display:flex;flex-direction:column;gap:1rem">
        <div>
          <strong style="color:var(--accent)">🐾 OpenClaw</strong>
          <div class="muted" style="font-size:11px">control plane</div>
        </div>
        <nav class="col" style="gap:.25rem">
          <a routerLink="/projects" routerLinkActive="active" [routerLinkActiveOptions]="{exact:false}">Projects</a>
          <a routerLink="/agents" routerLinkActive="active">Agents</a>
          <a routerLink="/sessions" routerLinkActive="active">Live sessions</a>
          <a routerLink="/memories" routerLinkActive="active">Memories</a>
        </nav>
        <div style="margin-top:auto" class="col">
          <div class="muted" style="font-size:11px">
            stream: <span [style.color]="sse.connected() ? 'var(--ok)' : 'var(--err)'">
              {{ sse.connected() ? 'live' : 'offline' }}
            </span>
          </div>
          @if (user()) {
            <div class="muted" style="font-size:11px">{{ user()?.username }}</div>
            <button (click)="logout()">Logout</button>
          }
        </div>
      </aside>
      <main style="padding:1.5rem;max-width:1400px;width:100%">
        <router-outlet />
      </main>
    </div>
  `,
  styles: [`
    a { padding:.4rem .6rem;border-radius:6px;color:var(--text); }
    a:hover, a.active { background:var(--panel-2);text-decoration:none;color:var(--accent); }
  `],
})
export class ShellComponent implements OnInit, OnDestroy {
  private api = inject(ApiService);
  sse = inject(SseService);
  user = signal<{ username: string; avatar?: string } | null>(null);

  ngOnInit() {
    this.sse.connect();
    this.api.me().subscribe({ next: (u) => this.user.set(u), error: () => {} });
  }
  ngOnDestroy() { this.sse.disconnect(); }
  logout() { this.api.logout().subscribe(() => location.href = '/login'); }
}
