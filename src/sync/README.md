# Dependencies needed for the SyncModule

If not already present in your NestJS project's package.json, install:

```bash
npm install @nestjs/config @nestjs/schedule mysql2 pg joi cron
npm install -D @types/pg
```

## Wiring into your app

1. Copy the `sync/` folder into your NestJS project's `src/` directory.
2. Import `SyncModule` into your root module:

```ts
// app.module.ts
import { Module } from '@nestjs/common';
import { SyncModule } from './sync/sync.module';

@Module({
  imports: [
    // ...your other modules
    SyncModule,
  ],
})
export class AppModule {}
```

3. Add the same environment variables from the standalone script's
   `.env.example` to your NestJS app's `.env`:

```
MYSQL_HOST=localhost
MYSQL_PORT=3306
MYSQL_USER=corp_reader
MYSQL_PASSWORD=changeme
MYSQL_DATABASE=corp

PG_HOST=localhost
PG_PORT=5432
PG_USER=visitor_app
PG_PASSWORD=changeme
PG_DATABASE=visitor_app_db

SYNC_BATCH_SIZE=500
SYNC_CRON_MINUTES=5
```

   If `ConfigModule.forRoot()` is already called elsewhere in your app
   (very likely, in a real project), remove the duplicate call inside
   `sync.module.ts` and merge the Joi validation schema into your
   existing one instead — NestJS will throw if `ConfigModule.forRoot()`
   is registered as non-global more than once in overlapping scopes.

## What you get

- **`SyncService`** — the sync engine (same upsert logic as the
  standalone script), injectable anywhere else in the app if you need to
  trigger a sync from other business logic.
- **`SyncScheduler`** — runs `syncService.syncAll()` every `SYNC_CRON_MINUTES`
  minutes (default 5, set to 10 or anything else via env — no code
  change needed). Guards against overlapping runs if one sync takes
  longer than the interval.
- **`SyncController`** — `POST /admin/sync/run` (sync everything) and
  `POST /admin/sync/run/:table` (sync one table, e.g.
  `POST /admin/sync/run/new_session`) for manual/on-demand syncing from
  an admin panel. **The guard is commented out — wire up your actual
  auth before deploying this**, since it triggers a real (if bounded)
  database read/write load and shouldn't be publicly callable.

## Tuning the schedule

Interval is set via `SYNC_CRON_MINUTES` in `.env` (default `5`). Bump it
to `10` if 5 minutes turns out to be too frequent for your data volume
or DB load.

Different tables may eventually need different freshness:
- `events`, `location_address`, `venue_space`, `new_agenda/track/session`
  — change rarely, could run on a slower schedule.
- `events_chat`, `events_chatmember_v2`, `checkin_booth` — more
  time-sensitive if the visitor app surfaces near-real-time chat/checkin
  status.

Right now everything syncs together on the one interval for simplicity.
If tables need different cadences later, register a second `CronJob` in
`SyncScheduler` (via `schedulerRegistry.addCronJob`) calling
`syncService.syncOne(...)` for just that subset of tables.
