/**
 * Imported for its effect, before any other module of the app: zod decides
 * when a schema is built whether it may compile that schema's parser, and
 * probes `new Function` to find out. The
 * Content-Security-Policy forbids that (`script-src 'self'`), and although
 * zod catches the refusal, the browser still reports a violation on every
 * page load. Without the compiler zod parses with its ordinary code path.
 */
import { z } from 'zod';

z.config({ jitless: true });
