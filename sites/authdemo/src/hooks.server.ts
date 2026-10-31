import type { Handle } from '@sveltejs/kit/hooks';
import { userFromHeaders } from '#lib/user.ts';

// The one place identity is read. Everything else uses event.locals.user.
export const handle: Handle = ({ event, resolve }) => {
	event.locals.user = userFromHeaders(event.request.headers);
	return resolve(event);
};
