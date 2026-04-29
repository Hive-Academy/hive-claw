import { Component } from '@angular/core';

@Component({
  selector: 'oc-login',
  standalone: true,
  template: `
    <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;">
      <div class="card" style="max-width:420px;text-align:center">
        <h1 style="margin:0 0 .5rem">OpenClaw Control</h1>
        <p class="muted">Multi-agent orchestration dashboard</p>
        <a href="/auth/discord/login">
          <button class="primary" style="margin-top:1rem;font-size:15px;padding:.6rem 1.2rem">
            Continue with Discord
          </button>
        </a>
        <p class="muted" style="margin-top:1.5rem;font-size:11px">
          Only allowlisted Discord IDs may sign in. Local dev mode bypasses auth when DISCORD_CLIENT_ID is unset.
        </p>
      </div>
    </div>
  `,
})
export class LoginComponent {}
