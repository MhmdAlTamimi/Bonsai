import path, { type PlatformPath } from 'node:path';

/**
 * Comparing folders, on every platform.
 *
 * By `relative`, never by comparing text. On Windows the separator is `\`,
 * git writes `/`, the same folder is `C:\Users\me` and `c:\users\me`, and a
 * folder on another drive has no relative path at all. The checks this
 * replaced compared text: `startsWith(parent + '/')` answered "not inside"
 * for every folder on Windows, and these answers decide which folders a
 * deletion may remove and which folder is the user's own.
 *
 * The platform's rules are a parameter so the Windows ones are tested on
 * every platform.
 */

/** Whether `child` is `parent` itself or somewhere inside it. */
export function isInside(parent: string, child: string, p: PlatformPath = path): boolean {
  const rel = p.relative(p.resolve(parent), p.resolve(child));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${p.sep}`) && !p.isAbsolute(rel));
}

/** Whether two paths name the same folder. */
export function samePath(a: string, b: string, p: PlatformPath = path): boolean {
  return p.relative(p.resolve(a), p.resolve(b)) === '';
}
