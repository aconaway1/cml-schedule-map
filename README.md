# CML Springfield Schedule Map

Cloudflare Pages site showing the Cousins Maine Lobster Springfield, IL food truck schedule on a map, filtered to Illinois stops.

## Deploy

### 1. Push to GitHub

Create a new repo and push this directory to it.

### 2. Create a Cloudflare Workers project

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com) → **Workers & Pages** → **Create application** → **Pages** → **Connect to Git**
2. Select your GitHub repo
3. On the **Set up your application** screen:
   - **Project name**: leave as-is
   - **Build command**: leave blank
   - **Deploy command**: leave as `npx wrangler deploy`
4. Click **Deploy**

The `wrangler.jsonc` in the repo tells Cloudflare where the static assets (`public/`) and worker entry point (`src/index.js`) live.

### 3. (Optional) KV namespace for geocode caching

Without this the function re-geocodes every request (fine for low traffic). With it, geocoded coordinates are cached for 30 days.

```sh
npx wrangler kv namespace create SCHEDULE_CACHE
```

Note the namespace ID from the output. Add it to `wrangler.jsonc`:

```jsonc
{
  "kv_namespaces": [
    { "binding": "SCHEDULE_CACHE", "id": "<your-namespace-id>" }
  ]
}
```

Then redeploy.

## Run locally

```sh
npx wrangler dev
```

This starts a local dev server at `http://localhost:8788`.

To test with a KV binding locally, add a `[dev]` section to `wrangler.jsonc` or create a `.dev.vars` file — or just omit it and the function skips caching.

## Architecture

```
src/index.js        # Worker: routes /api/schedule, falls through to static assets
public/index.html   # Leaflet map that fetches /api/schedule
wrangler.jsonc      # Points Cloudflare at src/index.js and public/
```

### Data flow

1. Fetch the CML location page server-side to extract calendar IDs from the embedded `__NEXT_DATA__` JSON blob
2. POST each calendar ID to the CML schedule API (`lobster-staging.herokuapp.com/trucks/single-schedule`) in parallel
3. Flatten and dedupe events across all calendars; filter to the requested state (`, IL` etc.)
4. Geocode addresses via Nominatim (OpenStreetMap), cached in KV if bound
5. Return `{ fetchedAt, count, stops[] }` — cached by CDN for 1 hour
