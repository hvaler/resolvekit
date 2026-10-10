import { describe, expect, it } from 'vitest';
import { safeNext } from './AuthPages';

describe('safeNext', () => {
  it('only same-site app paths come back after signing in (no open redirect)', () => {
    expect(safeNext('/cases/PP-R-TVH-10190665')).toBe('/cases/PP-R-TVH-10190665');
    expect(safeNext('/?q=1')).toBe('/?q=1');
    for (const bad of [null, '', 'https://evil.example', '//evil.example', String.raw`/\evil.example`, String.raw`/x\..\//evil.example`, '/\t/evil.example', '/\n/evil.example', '/ /evil.example', '/%2F/evil.example/../..//x', '/./../api/auth/signout', 'javascript:alert(1)', '/api/auth/signout']) expect(safeNext(bad)).toBe('/');
  });
});
