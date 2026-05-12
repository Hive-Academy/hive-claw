import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { ApiService } from '../services/api.service';
import { SseService } from '../services/sse.service';
import { ToastService } from '../services/toast.service';
import { BreadcrumbsComponent } from './breadcrumbs.component';
import { interval, Subscription } from 'rxjs';
import type { HealthStatus } from '../models/index';

@Component({
  selector: 'oc-shell',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, BreadcrumbsComponent],
  template: `
    <div class="drawer lg:drawer-open min-h-screen">
      <input id="drawer-toggle" type="checkbox" class="drawer-toggle" />
      <div class="drawer-content flex flex-col">
        <!-- Topbar -->
        <div class="navbar bg-base-200 border-b border-base-300 px-4 py-2">
          <div class="flex-none lg:hidden">
            <label for="drawer-toggle" class="btn btn-square btn-ghost">
              <svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"/></svg>
            </label>
          </div>
          <div class="flex-1">
            <oc-breadcrumbs />
          </div>
          <div class="flex-none flex items-center gap-3">
            <!-- TASK_2026_004: explicit "no autonomous work" badge.
                 Permanent fixture so the operator can never wonder whether
                 something is running on a timer. -->
            <div
              class="badge badge-sm badge-warning gap-1"
              title="HITL mode — no continuation loop. Tasks only advance when you click Run phase on the dashboard."
            >
              <span class="w-2 h-2 rounded-full bg-warning"></span>
              loop: OFF
            </div>
            @if (health(); as h) {
              <div class="badge badge-sm" [class]="h.ok ? 'badge-success' : 'badge-error'">
                {{ h.leader ? 'leader' : 'follower' }}
              </div>
            }
            <div class="badge badge-sm gap-1" [class]="sse.connected() ? 'badge-success' : 'badge-error'">
              <span class="w-2 h-2 rounded-full" [class]="sse.connected() ? 'bg-success' : 'bg-error'"></span>
              {{ sse.connected() ? 'live' : 'offline' }}
            </div>
            @if (user(); as u) {
              <div class="dropdown dropdown-end">
                <label tabindex="0" class="btn btn-ghost btn-sm normal-case gap-2">
                  @if (u.avatar) {
                    <img [src]="u.avatar" class="w-5 h-5 rounded-full" alt="" />
                  }
                  <span class="hidden sm:inline">{{ u.username }}</span>
                </label>
                <ul tabindex="0" class="dropdown-content menu menu-sm z-50 mt-3 w-52 rounded-box bg-base-200 p-2 shadow">
                  <li><button (click)="logout()">Logout</button></li>
                </ul>
              </div>
            }
          </div>
        </div>

        <!-- Main content -->
        <main class="p-4 lg:p-6 max-w-[1600px] w-full mx-auto">
          <router-outlet />
        </main>
      </div>

      <!-- Sidebar -->
      <div class="drawer-side z-40">
        <label for="drawer-toggle" class="drawer-overlay"></label>
        <aside class="bg-base-200 w-64 min-h-full flex flex-col border-r border-base-300">
          <div class="p-4 border-b border-base-300">
            <a routerLink="/" class="text-xl font-bold text-primary flex items-center gap-2">
              <span>🐾</span> OpenClaw
            </a>
            <div class="text-xs text-base-content/60 mt-1">control plane</div>
          </div>
          <nav class="menu menu-md p-2 flex-1 gap-1">
            <li>
              <a routerLink="/projects" routerLinkActive="active" [routerLinkActiveOptions]="{exact:false}">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/></svg>
                Projects
              </a>
            </li>
            <li>
              <a routerLink="/agents" routerLinkActive="active">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0z"/></svg>
                Agents
              </a>
            </li>
            <li>
              <a routerLink="/dispatches" routerLinkActive="active">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
                Dispatches
              </a>
            </li>
            <li>
              <a routerLink="/sessions" routerLinkActive="active">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 10l4.553-2.276A1 1 0 0121 8.818v6.364a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>
                Live sessions
              </a>
            </li>
            <li>
              <a routerLink="/memories" routerLinkActive="active">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4"/></svg>
                Memories
              </a>
            </li>
          </nav>
          <div class="p-4 border-t border-base-300 text-xs text-base-content/60 space-y-1">
            @if (health(); as h) {
              <div>storage: {{ h.storage }}</div>
              @if (h.dbVersion) { <div>db v{{ h.dbVersion }}</div> }
            }
            <div>agents: {{ localAgents().join(', ') || 'none' }}</div>
          </div>
        </aside>
      </div>
    </div>

    <!-- Toast container -->
    <div class="toast toast-bottom toast-end z-50">
      @for (t of toast.queue(); track t.id) {
        <div class="alert alert-sm" [class]="'alert-' + t.type">
          <span>{{ t.message }}</span>
          <button class="btn btn-xs btn-ghost" (click)="toast.remove(t.id)">×</button>
        </div>
      }
    </div>
  `,
})
export class ShellComponent implements OnInit, OnDestroy {
  private api = inject(ApiService);
  private healthSub: Subscription | null = null;
  sse = inject(SseService);
  toast = inject(ToastService);
  user = signal<{ username: string; avatar?: string } | null>(null);
  health = signal<HealthStatus | null>(null);
  localAgents = signal<string[]>([]);

  ngOnInit() {
    this.sse.connect();
    this.api.me().subscribe({
      next: (u) => this.user.set(u),
      error: () => {},
    });
    this.refreshHealth();
    this.healthSub = interval(30_000).subscribe(() => this.refreshHealth());
  }

  ngOnDestroy() {
    this.sse.disconnect();
    this.healthSub?.unsubscribe();
  }

  private refreshHealth() {
    this.api.health().subscribe({
      next: (h) => {
        this.health.set(h);
        this.localAgents.set(h.localAgentIds ?? []);
      },
      error: () => {},
    });
  }

  logout() {
    this.api.logout().subscribe(() => {
      location.href = '/login';
    });
  }
}
