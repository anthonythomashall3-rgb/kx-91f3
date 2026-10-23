-- IP lock (23 Oct 2026): remember each locked device's IP so the gate can restrict the quiz to the
-- IPs of locked computers. Apply once; "duplicate column" = already applied.
ALTER TABLE locks ADD COLUMN ip TEXT;
