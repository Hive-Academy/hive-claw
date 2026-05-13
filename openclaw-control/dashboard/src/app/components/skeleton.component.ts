import { Component, input } from '@angular/core';

@Component({
  selector: 'oc-skeleton',
  standalone: true,
  template: `
    @for (i of items; track i) {
      <div class="skeleton" [class]="cls()"></div>
    }
  `,
})
export class SkeletonComponent {
  count = input(1);
  cls = input('h-4 w-full');
  get items() {
    return Array.from({ length: this.count() }, (_, i) => i);
  }
}
