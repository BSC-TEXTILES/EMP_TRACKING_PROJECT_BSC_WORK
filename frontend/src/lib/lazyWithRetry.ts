import { ComponentType, lazy, type LazyExoticComponent } from 'react';

/**
 * Enhanced lazy component loader with automatic retry, network fault tolerance,
 * and seamless version self-healing.
 *
 * When a new deployment rolls out new hashed filenames (e.g. /assets/Projects-[newHash].js),
 * clients with open tabs requesting old hashes get dynamic import errors.
 * This wrapper automatically catches chunk load failures, verifies against a reload loop guard,
 * and smoothly refreshes the page so the user never gets an error card.
 */
export function lazyWithRetry<T extends ComponentType<any>>(
  factory: () => Promise<{ default: T }>,
  name?: string
): LazyExoticComponent<T> {
  return lazy(async () => {
    const key = `chunk_reload_${name || 'route'}`;

    try {
      return await factory();
    } catch (firstError: any) {
      // 1. Brief pause and 1st retry for transient connection drops
      try {
        await new Promise((res) => setTimeout(res, 400));
        return await factory();
      } catch (secondError: any) {
        // 2. Second retry with slightly longer backoff
        try {
          await new Promise((res) => setTimeout(res, 1000));
          return await factory();
        } catch (finalError: any) {
          const msg = String(finalError?.message || '');
          const isChunkMismatch =
            finalError?.name === 'ChunkLoadError' ||
            /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Loading chunk [\w\d]+ failed|mime type/i.test(
              msg
            );

          if (isChunkMismatch) {
            const lastReload = parseInt(sessionStorage.getItem(key) || '0', 10);
            const now = Date.now();
            // Don't loop infinitely: reload at most once every 10 seconds per route
            if (now - lastReload > 10000) {
              sessionStorage.setItem(key, String(now));
              const url = new URL(window.location.href);
              url.searchParams.set('_v', String(now));
              window.location.replace(url.toString());
              // Return unresolved promise while browser reloads to prevent ErrorBoundary flash
              return new Promise<{ default: T }>(() => {});
            }
          }
          throw finalError;
        }
      }
    }
  });
}
