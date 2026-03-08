-- Add prep_time and estimated_delivery_time columns to orders table
-- prep_time: stores the preparation time in minutes (set when accepting an order)
-- estimated_delivery_time: stores the calculated timestamp when order will be ready

-- Add prep_time column (stores minutes)
ALTER TABLE public.orders
ADD COLUMN IF NOT EXISTS prep_time integer;

-- Add estimated_delivery_time column with timezone support
ALTER TABLE public.orders
ADD COLUMN IF NOT EXISTS estimated_delivery_time timestamp with time zone;

-- Add comment for documentation
COMMENT ON COLUMN public.orders.prep_time IS 'Preparation time in minutes, set when order is accepted';
COMMENT ON COLUMN public.orders.estimated_delivery_time IS 'Estimated timestamp when order will be ready for delivery/pickup (with timezone)';
