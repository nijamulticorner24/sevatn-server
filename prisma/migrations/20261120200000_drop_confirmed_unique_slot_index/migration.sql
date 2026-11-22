-- Drop the erroneous unique index on date/route/slot which blocked valid bookings for multiple devotees
DROP INDEX IF EXISTS "idx_unique_confirmed_slot";

-- Enforce uniqueness on the real authoritative government pass reference across confirmed bookings
CREATE UNIQUE INDEX IF NOT EXISTS "idx_unique_official_booking_ref"
ON "BookingRequest" ("officialBookingReference")
WHERE "officialBookingReference" IS NOT NULL AND (status = 'BOOKING_CONFIRMED' OR status = 'SUCCESS');
