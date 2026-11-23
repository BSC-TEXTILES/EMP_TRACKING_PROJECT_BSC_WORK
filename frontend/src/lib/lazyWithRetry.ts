import { ComponentType, lazy, type LazyExoticComponent } from 'react';

/**
 * Checks whether an error is caused by a deployment chunk mismatch, stale script hash,
 * network drop, or dynamic module resolution returning undefined.
 */
export function isChunkOrModuleMismatch(error: unknown): boolean {
  if (!error) return false;
  const msg = typeof error === 'string' ? error : String((error as any)?.message || (error as any)?.description || '');
  const name = String((error as any)?.name || '');
  return (
    name === 'ChunkLoadError' ||
    /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Loading chunk [\w\d]+ failed|Loading CSS chunk [\w\d]+ failed|mime type|unexpected token '<'|Cannot read propert(y|ies) of undefined \(reading ['"]default['"]\)|reading ['"]default['"]|undefined is not an object \(evaluating ['"].*default['"]\)|Failed to resolve module specifier|does not contain a default export|Module resolution returned undefined/i.test(
      msg
    )
  );
}

/**
 * Enhanced lazy component loader with automatic retry, network fault tolerance,
 * defensive module resolution, and seamless version self-healing.
 *
 * Prevents React's "Cannot read properties of undefined (reading 'default')" by:
 * 1. Validating the imported module and safely resolving default or named component exports.
 * 2. Retrying transient connection failures.
 * 3. Detecting outdated chunk hashes after new deployments, busting browser cache,
 *    and refreshing seamlessly without flashing an ErrorBoundary crash card.
 */
export function lazyWithRetry<T extends ComponentType<any>>(
  factory: () => Promise<{ default: T } | any>,
  name?: string
): LazyExoticComponent<T> {
  return lazy(async () => {
    const key = `chunk_reload_${name || 'route'}`;

    const resolveModule = async (): Promise<{ default: T }> => {
      const mod = await factory();
      if (!mod) {
        throw new Error(`Module resolution returned undefined for route "${name || 'unknown'}"`);
      }
      if (mod.default && (typeof mod.default === 'function' || typeof mod.default === 'object')) {
        return mod as { default: T };
      }
      // If module is itself a component function (e.g. named or commonjs export)
      if (typeof mod === 'function') {
        return { default: mod as unknown as T };
      }
      // If module has a named export matching the route name or capitalized name
      const candidateKey = name ? name.split(/[-_]/).map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join('') : '';
      if (candidateKey && typeof (mod as any)[candidateKey] === 'function') {
        return { default: (mod as any)[candidateKey] as T };
      }
      if (name && typeof (mod as any)[name] === 'function') {
        return { default: (mod as any)[name] as T };
      }
      // Fallback: look for first exported function
      const firstComp = Object.values(mod).find((val) => typeof val === 'function');
      if (firstComp) {
        return { default: firstComp as unknown as T };
      }

      throw new Error(`Module loaded for route "${name || 'unknown'}" does not contain a default export`);
    };

    try {
      return await resolveModule();
    } catch (firstError: any) {
      // 1. Brief pause and 1st retry for transient connection drops
      try {
        await new Promise((res) => setTimeout(res, 400));
        return await resolveModule();
      } catch (secondError: any) {
        // 2. Second retry with slightly longer backoff
        try {
          await new Promise((res) => setTimeout(res, 1000));
          return await resolveModule();
        } catch (finalError: any) {
          if (isChunkOrModuleMismatch(finalError)) {
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
