const LEAVE_DURATION_MS = 160;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const main = document.querySelector<HTMLElement>('[data-page-transition-content]');

let isLeaving = false;
let navigationTimer: number | undefined;

const normalizePathname = (pathname: string) =>
  pathname === '/' ? pathname : pathname.replace(/\/+$/, '');

const clearNavigationTimer = () => {
  if (navigationTimer === undefined) return;
  window.clearTimeout(navigationTimer);
  navigationTimer = undefined;
};

const restorePage = () => {
  clearNavigationTimer();
  isLeaving = false;
  document.body.classList.remove('page-transition-leaving');
};

window.addEventListener('pageshow', restorePage);
window.addEventListener('pagehide', clearNavigationTimer);

document.addEventListener('click', (event) => {
  if (!(event instanceof MouseEvent) || event.defaultPrevented || event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

  const target = event.target instanceof Element ? event.target : null;
  const link = target?.closest<HTMLAnchorElement>('a[data-page-transition-nav]');
  if (!link || link.target === '_blank' || link.hasAttribute('download')) return;

  const destination = new URL(link.href, window.location.href);
  if (destination.origin !== window.location.origin) return;

  const currentPathname = normalizePathname(window.location.pathname);
  const destinationPathname = normalizePathname(destination.pathname);

  if (destinationPathname === currentPathname) {
    event.preventDefault();
    return;
  }

  if (isLeaving) {
    event.preventDefault();
    return;
  }

  if (reducedMotion.matches || !main) return;

  event.preventDefault();
  isLeaving = true;
  document.body.classList.add('page-transition-leaving');

  navigationTimer = window.setTimeout(() => {
    navigationTimer = undefined;
    window.location.assign(destination.href);
  }, LEAVE_DURATION_MS);
});
