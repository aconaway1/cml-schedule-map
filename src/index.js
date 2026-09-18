const CML_LOCATION_URL = 'https://www.cousinsmainelobster.com/locations/springfield-il';
const DEFAULT_STATE = 'IL';
const SCHEDULE_API = 'https://lobster-staging.herokuapp.com/trucks/single-schedule';
const UA = 'CML-Schedule-Map/1.0 (+https://cml.pages.dev)';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/schedule') {
      return handleSchedule(url.searchParams, env);
    }

    // All other requests go to static assets
    return env.ASSETS.fetch(request);
  },
};

async function handleSchedule(params, env) {
  const locationUrl = params.get('locationUrl') || CML_LOCATION_URL;
  const state = (params.get('state') || DEFAULT_STATE).toUpperCase();

  // Extract calendar IDs and truck name from CML location page's embedded __NEXT_DATA__
  let calendarIds, truckName;
  try {
    const pageRes = await fetch(locationUrl, { headers: { 'User-Agent': UA } });
    if (!pageRes.ok) throw new Error(`CML page returned ${pageRes.status}`);
    const html = await pageRes.text();

    const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([^<]+)<\/script>/);
    if (!m) throw new Error('__NEXT_DATA__ not found');

    const nextData = JSON.parse(m[1]);
    const truck = nextData?.props?.pageProps?.data?.foodTruckCollection?.items?.[0];
    if (!truck) throw new Error('foodTruckCollection missing');

    truckName = truck.title ?? 'Springfield, IL';
    calendarIds = [...new Set(truck.calendarIds ?? [])];
  } catch (err) {
    return jsonError(`Failed to load CML page: ${err.message}`, 502);
  }

  if (calendarIds.length === 0) return jsonError('No calendar IDs found', 502);

  // Fetch schedule for each calendar ID in parallel
  const results = await Promise.allSettled(
    calendarIds.map(id =>
      fetch(SCHEDULE_API, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': UA,
          'Origin': 'https://www.cousinsmainelobster.com',
          'Referer': 'https://www.cousinsmainelobster.com/',
        },
        body: JSON.stringify({ calendarId: id, truckStates: [{ name: truckName, calendarId: id }] }),
      }).then(r => {
        if (!r.ok) throw new Error(`schedule API returned ${r.status}`);
        return r.json();
      })
    )
  );

  // Flatten events across all calendars and days; dedupe by start+location
  const seen = new Set();
  const events = [];

  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    for (const truckData of result.value) {
      for (const dayEvents of Object.values(truckData.events ?? {})) {
        for (const ev of dayEvents ?? []) {
          const key = `${ev.start}|${ev.location}`;
          if (seen.has(key)) continue;
          seen.add(key);
          events.push(ev);
        }
      }
    }
  }

  // Filter to the requested state, sort by start time
  const stateEvents = events
    .filter(ev => matchesState(ev.location, state))
    .sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0);

  // Geocode each stop sequentially, respecting Nominatim's 1 req/sec policy
  const stops = [];
  for (const ev of stateEvents) {
    const tz = ev.startTz ?? 'America/Chicago';
    const coords = await geocode(ev.location, env?.SCHEDULE_CACHE);
    if (coords) {
      stops.push({
        title: ev.summary,
        address: ev.location,
        start: naiveLocalToUtc(stripOffset(ev.start), tz),
        end: ev.end ? naiveLocalToUtc(stripOffset(ev.end), tz) : null,
        timezone: tz,
        isAllDay: ev.isAllDay ?? false,
        lat: coords.lat,
        lng: coords.lng,
      });
    }
    if (!env?.SCHEDULE_CACHE) await sleep(1050); // only sleep when not cached
  }

  return new Response(JSON.stringify({ fetchedAt: new Date().toISOString(), count: stops.length, stops }), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}

// The CML API returns timestamps with an incorrect UTC offset (always -07:00 PDT).
// Strip it and treat the date/time part as a naive local time in the event's timezone.
function stripOffset(isoStr) {
  return isoStr.replace(/[+-]\d{2}:\d{2}$/, '').replace(/Z$/, '');
}

function naiveLocalToUtc(naive, timezone) {
  const fakeUtc = new Date(naive + 'Z');
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(fakeUtc).map(({ type, value }) => [type, value]));
  const shownUtc = new Date(Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second));
  return new Date(fakeUtc.getTime() + (fakeUtc.getTime() - shownUtc.getTime())).toISOString();
}

function matchesState(address, stateAbbr) {
  if (!address) return false;
  return new RegExp(`,\\s*${stateAbbr}\\b`, 'i').test(address);
}

async function geocode(address, kv) {
  if (!address) return null;
  const cacheKey = `geo:${address}`;

  if (kv) {
    const cached = await kv.get(cacheKey, 'json');
    if (cached) return cached;
  }

  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&limit=1`;
  let coords = null;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (res.ok) {
      const data = await res.json();
      if (data.length) coords = { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
    }
  } catch (_) {}

  if (coords && kv) {
    await kv.put(cacheKey, JSON.stringify(coords), { expirationTtl: 86400 * 30 });
  }

  return coords;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
