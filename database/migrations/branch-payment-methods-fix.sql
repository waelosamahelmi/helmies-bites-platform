-- ========================================
-- Fix: Branch Payment Methods Table
-- ========================================
-- The original migration used a different structure.
-- This creates the correct table structure expected by the application.

-- Drop the old table if it exists (it has wrong structure)
DROP TABLE IF EXISTS branch_payment_methods CASCADE;

-- Create the correct table structure
CREATE TABLE branch_payment_methods (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  payment_method VARCHAR(100) NOT NULL,
  is_enabled BOOLEAN DEFAULT true,
  display_order INTEGER DEFAULT 0,
  settings JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  -- Each branch can only have one entry per payment method
  UNIQUE(branch_id, payment_method)
);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_branch_payment_methods_branch ON branch_payment_methods(branch_id);
CREATE INDEX IF NOT EXISTS idx_branch_payment_methods_method ON branch_payment_methods(payment_method);
CREATE INDEX IF NOT EXISTS idx_branch_payment_methods_enabled ON branch_payment_methods(is_enabled);

-- Enable RLS
ALTER TABLE branch_payment_methods ENABLE ROW LEVEL SECURITY;

-- RLS policies - allow authenticated users full access (admin app)
CREATE POLICY "Allow authenticated users to view branch_payment_methods"
  ON branch_payment_methods FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Allow authenticated users to insert branch_payment_methods"
  ON branch_payment_methods FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Allow authenticated users to update branch_payment_methods"
  ON branch_payment_methods FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Allow authenticated users to delete branch_payment_methods"
  ON branch_payment_methods FOR DELETE
  TO authenticated
  USING (true);

-- Also allow anonymous users to read (for customer ordering)
CREATE POLICY "Allow anonymous users to view branch_payment_methods"
  ON branch_payment_methods FOR SELECT
  TO anon
  USING (true);

-- Comments for documentation
COMMENT ON TABLE branch_payment_methods IS 'Stores payment method settings per branch';
COMMENT ON COLUMN branch_payment_methods.branch_id IS 'Reference to branches table';
COMMENT ON COLUMN branch_payment_methods.payment_method IS 'Payment method key (e.g., cash_or_card, stripe_card, apple_pay)';
COMMENT ON COLUMN branch_payment_methods.is_enabled IS 'Whether this payment method is enabled for this branch';
COMMENT ON COLUMN branch_payment_methods.display_order IS 'Order in which to display payment methods';
COMMENT ON COLUMN branch_payment_methods.settings IS 'Additional settings for this payment method (JSON)';
