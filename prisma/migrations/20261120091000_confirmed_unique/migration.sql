-- Q5/F4: enforce exactly one CONFIRMED per business key
CREATE UNIQUE INDEX IF NOT EXISTS "idx_unique_confirmed_slot"
ON "BookingRequest" ("requestedDate", "route", COALESCE("selectedTime", ''))
WHERE status = 'BOOKING_CONFIRMED' OR status = 'SUCCESS';
