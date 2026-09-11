-- The Talk-to-us widget (issue #45).
--
-- Everything here exists because this is the first route in Callzie that is
-- reachable without a session. It runs on a stranger's browser, on somebody
-- else's domain, and it creates Retell Calls — which is to say it spends money.
--
-- So the columns below are not configuration, they are the fence: a key that
-- identifies the tenant and nothing else, a list of origins that key works from,
-- and a daily ceiling that holds even if both of those are defeated.

-- The public identifier that appears in the embed snippet.
--
-- UNIQUE because it is a lookup key, and NULL until somebody turns the widget
-- on — an account that has never enabled it must not have a usable key sitting
-- in the database waiting to be guessed.
--
-- Emphatically NOT a secret: it ships in HTML on a public page. It authorises
-- nothing on its own, which is what the origin allowlist below is for.
ALTER TABLE "businesses" ADD COLUMN "widget_key" text UNIQUE;
--> statement-breakpoint
-- Which origins that key works from. Empty means the widget is off.
--
-- A text array rather than a join table: it is read on every widget request and
-- written approximately never, it is always read whole, and a Business has a
-- handful of domains at most.
ALTER TABLE "businesses" ADD COLUMN "widget_origins" text[] NOT NULL DEFAULT '{}';
--> statement-breakpoint
-- The ceiling that holds when the key leaks and the thief is on the allowlist.
--
-- Separate from `inbound_quota`, which is the account's allowance across every
-- channel. This is a per-day rate on one channel, so a bad afternoon on the
-- website cannot silently consume an allowance somebody was holding for the
-- phone. Both apply; the lower one wins.
ALTER TABLE "businesses" ADD COLUMN "widget_daily_cap" integer NOT NULL DEFAULT 25;
