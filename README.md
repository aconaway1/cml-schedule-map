# CML Springfield Schedule Map

Cloudflare Pages site showing the Cousins Maine Lobster Springfield, IL food truck schedule on a map, filtered to Illinois stops.

## Deploy

### 1. Push to GitHub

Create a new repo and push this directory to it.

### 2. Create a Cloudflare Pages project

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com) → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**
2. Select your GitHub repo
3. Set build configuration:
   - **Build command**: *(leave blank)*
   - **Build output directory**: `public`
4. Click **Save and Deploy**

The `functions/` directory is automatically detected by Pages — no extra config needed.

### 3. (Optional) KV namespace for geocode caching

Without this the function re-geocodes every request (fine for low traffic). With it, geocoded coordinates are cached for 30 days.

```sh
npx wrangler kv namespace create SCHEDULE_CACHE
```

Note the namespace ID from the output, then in the Cloudflare Dashboard:

1. Go to your Pages project → **Settings** → **Functions** → **KV namespace bindings**
2. Add binding: **Variable name** = `SCHEDULE_CACHE`, **KV namespace** = the one you just created

## Run locally

```sh
npx wrangler pages dev public
```

This starts a local dev server at `http://localhost:8788` with the Pages Function hot-reloading.

To test with a KV binding locally, create a `.dev.vars` file (not committed) and add `SCHEDULE_CACHE` pointing to a local KV namespace — or just omit it and the function skips caching.

## Architecture

```
functions/api/schedule.js   # Pages Function: fetch → parse ICS → geocode → JSON
public/index.html           # Leaflet map that fetches /api/schedule
```

### Data flow

1. Fetch `cousinsmainelobster.com/locations/springfield-il` (server-side to avoid CORS)
2. Extract Google Calendar IDs from the embedded `__NEXT_DATA__` JSON blob
3. Fetch all ICS feeds in parallel from `calendar.google.com`
4. Parse VEVENT blocks (RFC 5545 line-unfolding, SUMMARY/LOCATION/DTSTART/DTEND)
5. Filter to Illinois events (`, IL`, "Illinois", or 600xx–629xx ZIP)
6. Geocode addresses via Nominatim (OpenStreetMap), cached in KV if bound
7. Return `{ fetchedAt, count, stops[] }` — cached by CDN for 1 hour
