import { App } from './app/App';
import './styles.css';

declare const __AD_RACERS_TEST__: boolean;

/**
 * Entry point.
 *
 * Everything that can fail before the game exists fails here, visibly, with an
 * explanation the player can act on — a blank canvas is the worst possible
 * outcome and is what this function exists to prevent.
 */

function fatal(heading: string, body: string, detail?: string): void {
  const app = document.getElementById('app');
  if (!app) return;
  app.innerHTML = '';
  const panel = document.createElement('section');
  panel.className = 'screen screen--message screen--error';
  panel.setAttribute('role', 'alert');
  const h1 = document.createElement('h1');
  h1.className = 'screen__heading';
  h1.textContent = heading;
  const p = document.createElement('p');
  p.className = 'screen__lead';
  p.textContent = body;
  panel.append(h1, p);
  if (detail) {
    const pre = document.createElement('pre');
    pre.className = 'message__detail';
    pre.textContent = detail;
    panel.append(pre);
  }
  app.append(panel);
}

function boot(): void {
  const root = document.getElementById('app');
  const canvas = document.getElementById('scene');

  if (!(root instanceof HTMLElement) || !(canvas instanceof HTMLCanvasElement)) {
    fatal('AD Racers could not start', 'The page did not load correctly. Reloading usually fixes it.');
    return;
  }

  // The canvas is decorative to assistive technology: everything it conveys is
  // also available as text in the HUD and its live region, so announcing it as
  // an image would only add noise.
  canvas.setAttribute('aria-hidden', 'true');
  canvas.removeAttribute('role');
  canvas.removeAttribute('aria-label');

  // Target for the skip link, so keyboard users can jump past nothing at all
  // and land somewhere focusable.
  const anchor = document.createElement('div');
  anchor.id = 'game';
  anchor.tabIndex = -1;
  root.prepend(anchor);

  const app = new App({ root, canvas });

  if (__AD_RACERS_TEST__) {
    (window as unknown as { adRacers?: unknown }).adRacers = app.testHooks;
  }
  app.start().catch((error: unknown) => {
    fatal(
      'AD Racers could not start',
      'Something failed while setting up the game. If this keeps happening, try another browser.',
      error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    );
  });

  window.addEventListener('pagehide', () => app.dispose());
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
