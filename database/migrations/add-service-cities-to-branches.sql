-- Add service_cities column to branches table
-- This column stores a comma-separated list of cities that each branch serves
-- For example, Tampere branch might serve: "Ylöjärvi,Nokia,Pirkkala,Lempäälä"

ALTER TABLE public.branches 
ADD COLUMN IF NOT EXISTS service_cities text;

-- Add a comment explaining the column
COMMENT ON COLUMN public.branches.service_cities IS 'Comma-separated list of cities this branch serves for delivery (e.g., "Ylöjärvi,Nokia,Pirkkala")';

-- Example: Update Tampere branch to serve nearby cities
-- UPDATE public.branches 
-- SET service_cities = 'Ylöjärvi,Nokia,Pirkkala,Lempäälä,Kangasala'
-- WHERE city = 'Tampere';
