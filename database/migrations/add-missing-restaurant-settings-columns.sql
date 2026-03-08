-- ========================================
-- Fix: Add missing columns to restaurant_settings
-- ========================================
-- Add columns that are in the Drizzle schema but missing from the database

ALTER TABLE restaurant_settings ADD COLUMN IF NOT EXISTS receipt_format TEXT DEFAULT 'text';
ALTER TABLE restaurant_settings ADD COLUMN IF NOT EXISTS direct_print_enabled BOOLEAN DEFAULT true;
