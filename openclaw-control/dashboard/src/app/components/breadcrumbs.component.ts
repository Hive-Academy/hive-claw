import { Component, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { signal } from '@angular/core';

interface Crumb {
  label: string;
  link?: string[];
}

@Component({
  selector: 'oc-breadcrumbs',
  standalone: true,
  imports: [RouterLink],
  template: `
    <div class="breadcrumbs text-sm">
      <ul>
        @for (c of crumbs(); track $index) {
          <li>
            @if (c.link) {
              <a [routerLink]="c.link" class="text-primary hover:underline">{{ c.label }}</a>
            } @else {
              <span class="text-base-content/70">{{ c.label }}</span>
            }
          </li>
        }
      </ul>
    </div>
  `,
})
export class BreadcrumbsComponent {
  private router = inject(Router);
  crumbs = signal<Crumb[]>([]);

  constructor() {
    this.updateCrumbs();
    this.router.events.subscribe(() => this.updateCrumbs());
  }

  private updateCrumbs() {
    const url = this.router.url;
    const segs = url.split('/').filter(Boolean);
    const crumbs: Crumb[] = [{ label: 'Home', link: ['/'] }];
    let path = '';
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      path += '/' + seg;
      const isLast = i === segs.length - 1;
      const label = decodeURIComponent(seg);
      if (!isLast && (seg === 'projects' || seg === 'tasks')) {
        crumbs.push({ label, link: [path] });
      } else {
        crumbs.push({ label });
      }
    }
    this.crumbs.set(crumbs);
  }
}
