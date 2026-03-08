-- Migration: Add service_fee to orders table
-- Description: Adds service_fee column to track online payment service fees per order

-- Add service_fee column to orders table
ALTER TABLE public.orders
ADD COLUMN IF NOT EXISTS service_fee DECIMAL(10, 2) DEFAULT 0;

-- Add comment for documentation
COMMENT ON COLUMN public.orders.service_fee IS 'Online payment service fee charged for this order';
