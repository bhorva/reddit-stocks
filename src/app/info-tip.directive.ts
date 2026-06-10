import { Directive, ElementRef, Input, OnDestroy, OnInit } from '@angular/core';

/**
 * Replaces the native `title`-attribute tooltip for ⓘ info icons with a
 * tap/click-friendly popover that also works on touch devices — the `title`
 * tooltip is invisible on mobile (hover-only).
 *
 * Usage: `<span class="info-icon" infoTip="Your explanation here">ⓘ</span>`
 *
 * Behaviour:
 *  - Keeps the native `title` so desktop mouse-hover still shows a tooltip.
 *  - On click/tap it appends, to <body> (so no overflow:hidden ancestor can
 *    clip it), a BACKDROP + the popover.
 *      · Desktop (≥640px): the popover is anchored below/above the icon.
 *      · Mobile (<640px): the popover is a BOTTOM SHEET pinned to the viewport
 *        bottom, the backdrop dims the page, and background scrolling is locked.
 *        This fixes the two mobile bugs the anchored-only version had: the
 *        popover appearing to "scroll with the page" (it was positioned once on
 *        open while the page kept scrolling behind it), and unreliable dismissal
 *        on touch (the old setTimeout + document-click-once trick was flaky).
 *  - Dismiss: tap the backdrop, tap ✕, or press ESC.
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
  private backdropEl: HTMLElement | null = null;
  private prevBodyOverflow = '';
  private readonly boundKeyEsc = (e: KeyboardEvent) => {
    if (e.key === 'Escape') this.closePopover();
  };

  private static readonly MOBILE_MAX = 640;
  private static readonly SCREEN_MARGIN = 10;

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
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    this.openPopover(rect);
  }

  private openPopover(anchorRect: DOMRect): void {
    const isMobile = window.innerWidth < InfoTipDirective.MOBILE_MAX;
    const M = InfoTipDirective.SCREEN_MARGIN;

    // Backdrop: reliably captures the dismiss tap (replaces the old fragile
    // setTimeout + document-click-once) and dims the page on mobile.
    const backdrop = document.createElement('div');
    Object.assign(backdrop.style, {
      position: 'fixed',
      inset: '0',
      zIndex: '9998',
      background: isMobile ? 'rgba(0,0,0,0.4)' : 'transparent',
    });
    backdrop.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closePopover();
    });

    const div = document.createElement('div');
    div.setAttribute('role', 'tooltip');
    div.setAttribute('aria-live', 'polite');
    Object.assign(div.style, {
      position: 'fixed',
      zIndex: '9999',
      background: '#fff',
      border: '1px solid #ddd',
      borderRadius: '12px',
      boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
      padding: '0.85rem 1rem',
      fontSize: '0.85rem',
      lineHeight: '1.5',
      color: '#444',
    });
    // A tap inside the popover must not bubble to the backdrop and close it.
    div.addEventListener('click', (e) => e.stopPropagation());

    if (isMobile) {
      // Bottom sheet: pinned to the viewport bottom, full width minus margins,
      // scrollable if the text is long. Never detaches from view, never clipped.
      Object.assign(div.style, {
        left: `${M}px`,
        right: `${M}px`,
        bottom: `${M}px`,
        maxHeight: '70vh',
        overflowY: 'auto',
      });
      // Lock the page so it can't scroll behind the open sheet.
      this.prevBodyOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    } else {
      // Desktop: anchor below the icon, flip above if it would overflow.
      const POPOVER_MAX_WIDTH = 320;
      const left = Math.max(
        M,
        Math.min(anchorRect.left, window.innerWidth - POPOVER_MAX_WIDTH - M),
      );
      const spaceBelow = window.innerHeight - anchorRect.bottom - M;
      const top = spaceBelow >= 60 ? anchorRect.bottom + 8 : Math.max(M, anchorRect.top - 8);
      Object.assign(div.style, {
        top: `${top}px`,
        left: `${left}px`,
        maxWidth: `min(${POPOVER_MAX_WIDTH}px, calc(100vw - ${M * 2}px))`,
      });
    }

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.setAttribute('aria-label', 'Schliessen');
    Object.assign(closeBtn.style, {
      float: 'right',
      background: 'none',
      border: 'none',
      cursor: 'pointer',
      color: '#bbb',
      fontSize: '1rem',
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
    document.body.appendChild(backdrop);
    document.body.appendChild(div);
    this.popoverEl = div;
    this.backdropEl = backdrop;

    // Desktop only: if the anchored popover still clips the bottom, flip it above.
    if (!isMobile) {
      requestAnimationFrame(() => {
        if (!this.popoverEl) return;
        const popRect = this.popoverEl.getBoundingClientRect();
        if (popRect.bottom > window.innerHeight - M) {
          this.popoverEl.style.top = `${Math.max(M, anchorRect.top - popRect.height - 8)}px`;
        }
      });
    }

    document.addEventListener('keydown', this.boundKeyEsc);
  }

  closePopover(): void {
    if (this.popoverEl) {
      this.popoverEl.remove();
      this.popoverEl = null;
    }
    if (this.backdropEl) {
      this.backdropEl.remove();
      this.backdropEl = null;
    }
    // Restore background scrolling (mobile sheet locked it).
    document.body.style.overflow = this.prevBodyOverflow;
    this.prevBodyOverflow = '';
    document.removeEventListener('keydown', this.boundKeyEsc);
  }

  ngOnDestroy(): void {
    this.closePopover();
  }
}
