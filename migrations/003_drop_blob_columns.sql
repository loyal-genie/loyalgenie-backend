-- Phase 4: remove legacy base64 image columns (images live in R2 only)

ALTER TABLE businesses DROP COLUMN IF EXISTS logo_data;
ALTER TABLE businesses DROP COLUMN IF EXISTS cover_banner_data;
ALTER TABLE businesses DROP COLUMN IF EXISTS interior_photos_data;
ALTER TABLE businesses DROP COLUMN IF EXISTS exterior_photos_data;
