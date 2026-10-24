// Typed access to this site's Durable Objects through the router's OBJECTS
// capability. The router fixes the hostname, so only this site's objects exist here.
import { env } from 'cloudflare:workers';

export function callObject<T>(className: string, name: string, method: string, ...args: unknown[]): Promise<T> {
	return env.OBJECTS.call(className, name, method, ...args) as Promise<T>;
}
