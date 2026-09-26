-- Remove the accounts and games left behind by automated testing.
-- Run in the Neon SQL Editor (console.neon.tech -> your project -> SQL Editor).
--
-- STEP 1: run ONLY the two SELECTs below and look at what they return.
-- STEP 2: if every row is test data (nothing that belongs to a real player),
--         run the BEGIN ... COMMIT block at the bottom.

-- ---- STEP 1: PREVIEW (changes nothing) -------------------------------------

SELECT id, email, display_name, created_at
FROM users
WHERE display_name IN (
  'Alice', 'Bob', 'AliceUI', 'BobUI', 'AliceMulti', 'BobMulti',
  'TestUser', 'TestPlayerOne', 'TestPlayerTwo', 'Player'
)
ORDER BY created_at;

SELECT id, white_name, black_name, result, end_reason, ended_at
FROM games
WHERE white_name IN ('Alice','Bob','AliceUI','BobUI','AliceMulti','BobMulti','TestUser','TestPlayerOne','TestPlayerTwo','Player','Anonymous Opponent')
   OR black_name IN ('Alice','Bob','AliceUI','BobUI','AliceMulti','BobMulti','TestUser','TestPlayerOne','TestPlayerTwo','Player','Anonymous Opponent')
ORDER BY ended_at;

-- ---- STEP 2: DELETE (only after checking the preview) -----------------------
-- Runs as one transaction: if anything looks off you can type ROLLBACK instead
-- of COMMIT and nothing is changed.

BEGIN;

CREATE TEMP TABLE test_users AS
  SELECT id FROM users WHERE display_name IN (
    'Alice', 'Bob', 'AliceUI', 'BobUI', 'AliceMulti', 'BobMulti',
    'TestUser', 'TestPlayerOne', 'TestPlayerTwo', 'Player'
  );

DELETE FROM ratings WHERE user_id IN (SELECT id FROM test_users);

DELETE FROM games
WHERE white_user_id IN (SELECT id FROM test_users)
   OR black_user_id IN (SELECT id FROM test_users)
   OR white_name IN ('Alice','Bob','AliceUI','BobUI','AliceMulti','BobMulti','TestUser','TestPlayerOne','TestPlayerTwo','Player','Anonymous Opponent')
   OR black_name IN ('Alice','Bob','AliceUI','BobUI','AliceMulti','BobMulti','TestUser','TestPlayerOne','TestPlayerTwo','Player','Anonymous Opponent');

DELETE FROM users WHERE id IN (SELECT id FROM test_users);

-- Sanity check before committing: what's left?
SELECT (SELECT count(*) FROM users) AS users_left,
       (SELECT count(*) FROM games) AS games_left,
       (SELECT count(*) FROM ratings) AS ratings_left;

COMMIT; -- or ROLLBACK; to undo everything above
