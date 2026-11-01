-- EXAMPLE ONLY: replace items / test_key / status with your application schema.
-- The mysql helper populates @test_key using a hex literal before this query.
-- Run with SELECT-only DB privileges. Output must be one numeric COUNT(*).
SELECT COUNT(*)
FROM items
WHERE test_key = @test_key
  AND status = 'CREATED';
