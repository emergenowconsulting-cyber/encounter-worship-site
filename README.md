# Encounter Worship Ministries website

Static site in `public/` plus one Netlify Function (`netlify/functions/api.mjs`) that stores
registrations, check-ins, T-shirt pre-orders and Collective accounts in Netlify Blobs.

## Netlify setup
1. Netlify > Add new project > Import an existing project > GitHub > `encounter-worship-site`.
2. Build settings are read from `netlify.toml` (no build command, publish `public`).
3. Add environment variable `ADMIN_PIN` (the door team's PIN), then deploy.

Team check-in and orders: `/#check-in` (needs the PIN).

## Local test
`npm install && node dev/server.mjs` then open http://localhost:8899 (PIN 1234, in-memory data).
