-- Admin > Payments lists the newest 300 payments: read them through an index on the date instead of
-- sorting every payment LOCKqz has ever received. One index row per payment (payments are rare writes).
CREATE INDEX IF NOT EXISTS idx_payments_received ON payments(received_at);
