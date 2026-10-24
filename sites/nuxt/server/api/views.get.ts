import { callObject } from '../utils/objects';

// GET /api/views: counts one page view and returns the total. The page calls
// this once per server render, so every SSR request is counted.
export default defineEventHandler(() => callObject<{ count: number; since: string | null }>('Counter', 'page-views', 'hit'));
