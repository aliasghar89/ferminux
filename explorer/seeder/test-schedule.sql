-- Boundary test for the reward schedule the explorer publishes.
--
--   docker exec fmx-explorer-db psql -U blockscout -d blockscout -f /seeder/test-schedule.sql
--
-- Run it after ANY edit to seed-rewards.sql, and on fork day before trusting a
-- single number on the explorer. It raises an exception on the first
-- disagreement, so a non-zero exit means do not ship.
--
-- It exists because a refactor of seed-rewards.sql silently changed the era
-- arithmetic from floor to round — every block from 2,250,000 would have been
-- published at half its true reward, years from now, with nothing to notice it.
-- The values below are computed from the Go source by hand, not from the SQL,
-- so the test cannot agree with the code by construction.
DO $$
DECLARE
  -- block, expected total, miner, sink, treasury
  cases numeric[][] := ARRAY[
    -- launch rate, 6 FMX, all to the miner
    [0,        6000000000000000000, 6000000000000000000, 0, 0],
    [19999,    6000000000000000000, 6000000000000000000, 0, 0],
    -- emission fork at 20,000: 1 FMX, still all to the miner
    [20000,    1000000000000000000, 1000000000000000000, 0, 0],
    [159999,   1000000000000000000, 1000000000000000000, 0, 0],
    -- authority fork at 160,000: quartered, then 40/50/10
    [160000,    250000000000000000,  100000000000000000, 125000000000000000, 25000000000000000],
    -- the block that caught the floor/round bug: still era 0
    [2250000,   250000000000000000,  100000000000000000, 125000000000000000, 25000000000000000],
    [4499999,   250000000000000000,  100000000000000000, 125000000000000000, 25000000000000000],
    -- era 1 begins exactly at 4,500,000
    [4500000,   125000000000000000,   50000000000000000,  62500000000000000, 12500000000000000],
    [9000000,    62500000000000000,   25000000000000000,  31250000000000000,  6250000000000000]
  ];
  i int;
  n numeric; want_total numeric; want_miner numeric; want_sink numeric; want_treas numeric;
  got_total numeric; got_miner numeric; got_sink numeric; got_treas numeric;
  checked int := 0;
BEGIN
  FOR i IN 1 .. array_length(cases, 1) LOOP
    n := cases[i][1]; want_total := cases[i][2]; want_miner := cases[i][3];
    want_sink := cases[i][4]; want_treas := cases[i][5];
    got_total := ferminux_subsidy_total(n);
    got_miner := ferminux_share_miner(n);
    got_sink  := ferminux_share_sink(n);
    got_treas := ferminux_share_treasury(n);
    IF got_total <> want_total THEN
      RAISE EXCEPTION 'block %: total is %, expected %', n, got_total, want_total; END IF;
    IF got_miner <> want_miner THEN
      RAISE EXCEPTION 'block %: miner share is %, expected %', n, got_miner, want_miner; END IF;
    IF got_sink <> want_sink THEN
      RAISE EXCEPTION 'block %: sink share is %, expected %', n, got_sink, want_sink; END IF;
    IF got_treas <> want_treas THEN
      RAISE EXCEPTION 'block %: treasury share is %, expected %', n, got_treas, want_treas; END IF;
    -- The three shares must account for the whole subsidy: no emission may be
    -- invented or lost to rounding between them.
    IF got_miner + got_sink + got_treas <> got_total THEN
      RAISE EXCEPTION 'block %: shares sum to %, not %', n, got_miner + got_sink + got_treas, got_total; END IF;
    checked := checked + 1;
  END LOOP;

  -- Monotonicity: the subsidy must never rise as the chain advances.
  IF EXISTS (
    SELECT 1 FROM generate_series(0, 20000000, 250000) AS g(n)
    WHERE ferminux_subsidy_total(g.n::numeric) > ferminux_subsidy_total(GREATEST(g.n - 250000, 0)::numeric)
      AND g.n > 0
  ) THEN
    RAISE EXCEPTION 'subsidy increases somewhere: the schedule is not monotonic';
  END IF;

  RAISE NOTICE 'schedule OK: % boundary cases, shares exact, monotonic to block 20,000,000', checked;
END $$;
