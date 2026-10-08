# Snake Royale

Multiplayer snake. Everyone online shares one arena (a new arena opens every 28 players). Eat to grow, make others crash into you, longest snake of the day tops the board. Bots (marked BOT) keep the arena lively when few people are online.

- `/` site with X Player Card meta, so the game can play inside a post
- `/embed` compact version for the in-post window (640x360)
- `/play` same site with a normal large-image card (use this link if your post shows no card)

## Run
npm install && npm start  →  http://localhost:3000

## Deploy on Render
New → Web Service → this repo. Build `npm install`, Start `npm start`, Free.
Optional: UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN env vars keep the leaderboard across restarts.
