# CML Springfield Schedule Map

## What this is

A Cloudflare Pages site that shows the Cousins Maine Lobster Springfield, IL
food truck's schedule on a map, filtered to Illinois-only stops. Built the
same way as ronconrails.com: static site + Pages Functions, no custom
domain (stays on `*.pages.dev`), no build step, no npm dependencies.

## Status

Scaffolded and untested. Two things need verifying before this is
considered working — see "Open items" below.

## Architecture

```
functions/api/schedule.js   # Pages Function — server-side fetch/parse/geocode
public/index.html           # Leaflet map, fetches /api/schedule on load
README.md                   # deploy instructions (Cloudflare dashboard steps)
```

No frontend framework, no build tooling. `schedule.js` runs entirely on
native Workers runtime APIs (`fetch`, no npm packages).

## How the data flow works

The CML location page (`https://www.cousinsmainelobster.com/locations/springfield-il`)
renders its truck schedule client-side, so the schedule data isn't in the
static HTML — this took a few iterations of the person checking their
browser's Network tab and view-source to find it. There is **no discrete
schedule API**. Instead:

1. The page embeds a Next.js `__NEXT_DATA__` JSON blob in a `<script>` tag.
2. Inside it, `props.pageProps.data.foodTruckCollection.items[].calendarIds`
   lists six Google Calendar IDs — the schedule is literally just public
   Google Calendars rendered into a table.
3. Each calendar has a public ICS feed at
   `https://calendar.google.com/calendar/ical/<id>/public/basic.ics` —
   no auth, no API key.

So `schedule.js`:
1. Fetches the location page HTML server-side (avoids browser CORS —
   `cousinsmainelobster.com` has no CORS headers for cross-origin fetch).
2. Regexes out the `__NEXT_DATA__` script content, parses it as JSON, pulls
   `calendarIds`.
3. Fetches all six `.ics` feeds in parallel, hand-parses VEVENT blocks
   (SUMMARY/LOCATION/DTSTART/DTEND, with RFC 5545 line-unfolding).
4. Filters events to ones whose `LOCATION` text matches IL (`, IL`,
   "Illinois", or a 600xx–629xx ZIP).
5. Geocodes surviving addresses via Nominatim (OpenStreetMap), optionally
   cached in a KV namespace bound as `SCHEDULE_CACHE` (function works fine
   without the binding, just re-geocodes every request).
6. Returns `{ fetchedAt, count, stops: [{ title, address, start, end, lat, lng }] }`.

`index.html` fetches that endpoint on load and drops a Leaflet marker per
stop (OpenStreetMap tiles, no API key), with a popup showing title/time/address.

## Key decisions already made (don't re-litigate without reason)

- **No headless browser / Browser Rendering binding** — turned out to be
  unnecessary once we found the calendar IDs; ICS feeds are cheap and
  don't need JS execution to read.
- **No custom domain** — explicit ask, stays on `pages.dev`.
- **Nominatim over a paid geocoder** — free, no key, fine for this request
  volume. Usage policy requires a real User-Agent (set in the code) and
  ~1 req/sec; not meant for bulk geocoding.
- **`calendarIds` read dynamically from the page each request**, not
  hardcoded, so it keeps working if CML adds/changes a truck's calendar.

## Open items — verify these before considering it done

1. **Have not confirmed a real ICS URL actually returns data.** The
   calendar IDs were found in the page's embedded JSON but never fetched
   and inspected. If Google returns 403/404 on the public feed URL despite
   the ID being embedded on the page, the calendars may not actually be
   shared publicly, and the whole approach needs rethinking.
2. **Have not seen a real event's LOCATION field.** The IL filter and the
   geocoder both assume it's a normal street address string. If entries
   are just a venue name with no state/ZIP, the filter will silently drop
   them (fails safe, but worth checking against real data before assuming
   IL stops are showing up correctly).
3. Never deployed or run locally (`npx wrangler pages dev public`) — no
   Cloudflare Pages project has been created yet.
4. KV namespace for geocode caching not yet created/bound — optional but
   recommended per the README.

## Deploy target

Cloudflare Pages, connected to a GitHub repo, build output directory
`public`, no build command. Full steps in `README.md`.
