import { Component } from '@angular/core';

@Component({
  selector: 'oc-login',
  standalone: true,
  template: `
    <div class="min-h-screen flex items-center justify-center bg-base-100 px-4">
      <div class="card bg-base-200 w-full max-w-md shadow-xl border border-base-300">
        <div class="card-body items-center text-center gap-4">
          <div class="text-5xl">🐾</div>
          <h1 class="card-title text-2xl">OpenClaw Control</h1>
          <p class="text-base-content/60">Multi-agent orchestration dashboard</p>
          <a href="/auth/discord/login" class="btn btn-primary w-full mt-2">
            Continue with Discord
          </a>
          <p class="text-xs text-base-content/50 mt-2">
            Only allowlisted Discord IDs may sign in. Local dev mode bypasses auth when DISCORD_CLIENT_ID is unset.
          </p>
        </div>
      </div>
    </div>
  `,
})
export class LoginComponent {}
