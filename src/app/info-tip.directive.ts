import { Directive, ElementRef, Input, OnDestroy, OnInit } from '@angular/core';

/**
 * Replaces the native `title`-attribute tooltip for ⓘ info icons with a
 * tap/click-friendly popover that also works on touch devices — the `title`
 * tooltip is invisible on mobile (hover-only).
 *
 * Usage: `<span class="info-icon" infoTip="Your explanation here">ⓘ</span>`
 *
 * The directive:
 *  - Sets `title` on the host element from `infoTip` so desktop users still
 *    get the native hover tooltip without any changes to their experience.
 *  - On click/tap: measures the host's position, appends a fixed-position
 *    popover to <body> (always visible, never clipped by overflow:hidden
 *    ancestors), and closes it on outside-click or ESC.
 *  - Cleans up the popover on directive destroy (e.g. route/component removal).
 *
 * Why DOM manipulation instead of an Angular overlay service?
 * The host element lives inside deeply nested table cells and card headers
 * that may have overflow:hidden — Angular CDK's Overlay or a portal-based
 * solution would be the "proper" Angular way but adds a large dependency for
 * a purely cosmetic, read-only tooltip. A self-contained body-appended div
 * is the minimal, reliable cross-browser solution for this exact use-case.
 */
@Directive({
  selector: '[infoTip]',
  standalone: true,
  host: {
    '(click)': 'handleClick($event)',
    '(keydown.enter)': 'handleClick($event)',
    '(keydown.escape)': 'closePopover()',
    tabindex: '0',
    role: 'button',
    'aria-label': 'Mehr Informationen',
  },
})
export class InfoTipDirective implements OnInit, OnDestroy {
  @Input() infoTip = '';

  private popoverEl: HTMLElement | null = null;
  private readonly boundOutsideClick = this.closePopover.bind(this);
  private readonly boundKeyEsc = (e: KeyboardEvent) => {
    if (e.key === 'Escape') this.closePopover();
  };

  constructor(private readonly el: ElementRef<HTMLElement>) {}

  ngOnInit(): void {
    // Keep the native title tooltip for desktop mouse-hover — zero-cost fallback.
    this.el.nativeElement.title = this.infoTip;
  }

  handleClick(event: Event): void {
    event.stopPropagation();
    if (this.popoverEl) {
      this.closePopover();
      return;
    }
    const host = event.currentTarget as HTMLElement;
    const rect = host.getBoundingClientRect();
    this.openPopover(rect);
  }

  private openPopover(anchorRect: DOMRect): void {
    const div = document.createElement('div');
    div.setAttribute('role', 'tooltip');
    div.setAttribute('aria-live', 'polite');

    // Position: prefer below the anchor; flip above if it would overflow the bottom.
    const POPOVER_MAX_WIDTH = 320;
    const SCREEN_MARGIN = 10;
    const left = Math.max(
      SCREEN_MARGIN,
      Math.min(anchorRect.left, window.innerWidth - POPOVER_MAX_WIDTH - SCREEN_MARGIN),
    );
    const spaceBelow = window.innerHeight - anchorRect.bottom - SCREEN_MARGIN;
    const top =
      spaceBelow >= 60
        ? anchorRect.bottom + 8
        : Math.max(SCREEN_MARGIN, anchorRect.top - 8); // approx above; JS will adjust after render

    Object.assign(div.style, {
      position: 'fixed',
      zIndex: '9999',
      top: `${top}px`,
      left: `${left}px`,
      maxWidth: `min(${POPOVER_MAX_WIDTH}px, calc(100vw - ${SCREEN_MARGIN * 2}px))`,
      background: '#fff',
      border: '1px solid #ddd',
      borderRadius: '10px',
      boxShadow: '0 4px 24px rgba(0,0,0,0.13)',
      padding: '0.75rem 0.9rem',
      fontSize: '0.82rem',
      lineHeight: '1.5',
      color: '#444',
      // Prevents the popover from acting as a click target that would close itself
      // via the outside-click listener (stopPropagation on the inner close btn handles it).
    });

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.setAttribute('aria-label', 'Schliessen');
    Object.assign(closeBtn.style, {
      float: 'right',
      background: 'none',
      border: 'none',
      cursor: 'pointer',
      color: '#bbb',
      fontSize: '0.85rem',
      marginLeft: '10px',
      padding: '0',
      lineHeight: '1',
    });
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closePopover();
    });

    const text = document.createElement('p');
    text.textContent = this.infoTip;
    Object.assign(text.style, { margin: '0' });

    div.appendChild(closeBtn);
    div.appendChild(text);
    document.body.appendChild(div);
    this.popoverEl = div;

    // After render, if it would clip the bottom, move it above the anchor.
    requestAnimationFrame(() => {
      if (!this.popoverEl) return;
      const popRect = this.popoverEl.getBoundingClientRect();
      if (popRect.bottom > window.innerHeight - SCREEN_MARGIN) {
        this.popoverEl.style.top = `${Math.max(SCREEN_MARGIN, anchorRect.top - popRect.height - 8)}px`;
      }
    });

    // Close on any outside click (setTimeout so this tick's click doesn't trigger it immediately).
    setTimeout(() => {
      document.addEventListener('click', this.boundOutsideClick, { once: true });
      document.addEventListener('keydown', this.boundKeyEsc);
    }, 0);
  }

  closePopover(): void {
    if (this.popoverEl) {
      document.body.removeChild(this.popoverEl);
      this.popoverEl = null;
    }
    document.removeEventListener('click', this.boundOutsideClick);
    document.removeEventListener('keydown', this.boundKeyEsc);
  }

  ngOnDestroy(): void {
    this.closePopover();
  }
}
