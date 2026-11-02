/**
 * IES account numbers for the search-usage export (Dan, 2026-11-02). The
 * AuthIES call is stubbed; what matters is that it is skipped without a
 * secret and that any failure leaves the export downloadable.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { lookupMemberNumbers } from './people-lookup';

const A = '0f8fad5b-d9cb-469f-a165-70867728950e';
const B = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const ENV = { PEOPLE_LOOKUP_API_SECRET: 's3cret', AUTH_IDP_BASE_URL: 'https://auth.ies.org' };
const URL_ = 'https://lens.ies.org/api/admin/search-usage.csv';

afterEach(() => vi.unstubAllGlobals());

describe('lookupMemberNumbers', () => {
  it('asks AuthIES once for the distinct ids and maps the answers', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      people: { [A]: { member_number: '123456' }, [B]: { member_number: null } },
    })));
    vi.stubGlobal('fetch', fetchMock);
    const map = await lookupMemberNumbers(ENV, URL_, [A, A.toUpperCase(), B, null]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://auth.ies.org/api/people/lookup');
    expect(init.headers.Authorization).toBe('Bearer s3cret');
    expect(JSON.parse(init.body)).toEqual({ person_uuids: [A, B] });
    expect([...map]).toEqual([[A, '123456']]);
  });

  it('does not call AuthIES without a secret', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect((await lookupMemberNumbers({}, URL_, [A])).size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers an empty map when AuthIES fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    expect((await lookupMemberNumbers(ENV, URL_, [A])).size).toBe(0);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
    expect((await lookupMemberNumbers(ENV, URL_, [A])).size).toBe(0);
  });
});
