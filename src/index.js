const CML_LOCATION_URL = 'https://www.cousinsmainelobster.com/locations/springfield-il';
const DEFAULT_STATE = 'IL';
const SCHEDULE_API = 'https://lobster-staging.herokuapp.com/trucks/single-schedule';
const UA = 'CML-Schedule-Map/1.0 (+https://cml.pages.dev)';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/schedule') return handleSchedule(url.searchParams, env);
    return env.ASSETS.fetch(request);
  },
};

async function handleSchedule(params, env) {
  // Support multiple locationUrl/state pairs via repeated params
  const locationUrls = params.getAll('locationUrl');
  const states = params.getAll('state');

  const locations = locationUrls.length > 0
    ? locationUrls.map((url, i) => ({ url, state: (states[i] || states[0] || DEFAULT_STATE).toUpperCase() }))
    : [{ url: CML_LOCATION_URL, state: DEFAULT_STATE }];

  // Fetch calendar IDs for all locations in parallel
  const locationData = await Promise.allSettled(locations.map(fetchCalendarIds));

  // Fetch schedules for all locations in parallel, then filter by state
  const allEvents = (await Promise.allSettled(
    locationData.map((result, i) => {
      if (result.status !== 'fulfilled') return Promise.resolve([]);
      const { calendarIds, truckName, state } = { ...result.value, state: locations[i].state };
      return fetchEvents(calendarIds, truckName, state);
    })
  )).flatMap(r => r.status === 'fulfilled' ? r.value : []);

  // Dedupe across locations by start+location, then sort
  const seen = new Set();
  const events = allEvents.filter(ev => {
    const key = `${ev.start}|${ev.location}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0);

  // Geocode sequentially (Nominatim: 1 req/sec policy)
  const stops = [];
  for (const ev of events) {
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
    if (!env?.SCHEDULE_CACHE) await sleep(1050);
  }

  return new Response(JSON.stringify({ fetchedAt: new Date().toISOString(), count: stops.length, stops }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' },
  });
}

async function fetchCalendarIds(location) {
  const pageRes = await fetch(location.url, { headers: { 'User-Agent': UA } });
  if (!pageRes.ok) throw new Error(`CML page returned ${pageRes.status}`);
  const html = await pageRes.text();

  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([^<]+)<\/script>/);
  if (!m) throw new Error('__NEXT_DATA__ not found');

  const nextData = JSON.parse(m[1]);
  const truck = nextData?.props?.pageProps?.data?.foodTruckCollection?.items?.[0];
  if (!truck) throw new Error('foodTruckCollection missing');

  return {
    truckName: truck.title ?? 'Unknown',
    calendarIds: [...new Set(truck.calendarIds ?? [])],
  };
}

async function fetchEvents(calendarIds, truckName, state) {
  if (!calendarIds.length) return [];

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

  return results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value)
    .flatMap(truckData => Object.values(truckData.events ?? {}).flat())
    .filter(ev => matchesState(ev.location, state));
}

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
  if (coords && kv) await kv.put(cacheKey, JSON.stringify(coords), { expirationTtl: 86400 * 30 });
  return coords;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
