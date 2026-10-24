// Typed access to this site's Durable Objects through the router's OBJECTS
// binding. `cloudflare:workers` stays external in the build (see nuxt.config.ts
// and RECIPE.md); the binding is only available inside a request.
import { env } from 'cloudflare:workers';

export function callObject<T>(className: string, name: string, method: string, ...args: unknown[]): Promise<T> {
	return env.OBJECTS.call(className, name, method, ...args) as Promise<T>;
}
