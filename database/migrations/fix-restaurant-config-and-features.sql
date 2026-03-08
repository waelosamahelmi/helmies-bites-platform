-- ========================================
-- Babylon Restaurant System Fixes & Features
-- ========================================
-- This migration fixes critical bugs and adds new features:
-- 1. Fix is_active toggle issue with restaurant_config
-- 2. Add branch-specific discount restrictions
-- 3. Add pickup-only discount option
-- 4. Add customer blacklist system
-- 5. Add customer accounts system
-- 6. Add loyalty program system
-- 7. Add coupon codes system
-- 8. Add branch-specific payment methods
-- 9. Add phone numbers configuration for multi-brand
-- ========================================

-- ========================================
-- 1. FIX: Restaurant Config is_active Toggle
-- ========================================

-- Add a trigger to ensure only ONE restaurant_config is active at a time
CREATE OR REPLACE FUNCTION ensure_single_active_restaurant_config()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.is_active = true THEN
    -- Deactivate all other configs
    UPDATE restaurant_config
    SET is_active = false
    WHERE id != NEW.id AND is_active = true;
  END IF;

  -- Ensure at least one config remains active if trying to deactivate the last one
  IF NEW.is_active = false THEN
    IF NOT EXISTS (
      SELECT 1 FROM restaurant_config
      WHERE id != NEW.id AND is_active = true
    ) THEN
      RAISE EXCEPTION 'Cannot deactivate the last active restaurant config. At least one must remain active.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop existing trigger if exists
DROP TRIGGER IF EXISTS trigger_ensure_single_active_config ON restaurant_config;

-- Create trigger
CREATE TRIGGER trigger_ensure_single_active_config
  BEFORE UPDATE OF is_active ON restaurant_config
  FOR EACH ROW
  EXECUTE FUNCTION ensure_single_active_restaurant_config();

-- ========================================
-- 2. ENHANCE: Promotions/Discounts Table
-- ========================================

-- Add columns for branch-specific and pickup-only discounts
ALTER TABLE promotions
  ADD COLUMN IF NOT EXISTS allowed_branches INTEGER[], -- NULL = all branches allowed
  ADD COLUMN IF NOT EXISTS pickup_only BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS delivery_only BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS dine_in_only BOOLEAN DEFAULT false;

-- Create index for branch filtering
CREATE INDEX IF NOT EXISTS idx_promotions_branches ON promotions USING GIN (allowed_branches);

COMMENT ON COLUMN promotions.allowed_branches IS 'Array of branch IDs where discount is valid. NULL means valid for all branches.';
COMMENT ON COLUMN promotions.pickup_only IS 'If true, discount only applies to pickup orders';
COMMENT ON COLUMN promotions.delivery_only IS 'If true, discount only applies to delivery orders';
COMMENT ON COLUMN promotions.dine_in_only IS 'If true, discount only applies to dine-in orders';

-- ========================================
-- 3. NEW: Customer Blacklist System
-- ========================================

CREATE TABLE IF NOT EXISTS customer_blacklist (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Identification fields
  email VARCHAR(255),
  phone VARCHAR(50),

  -- Reason for blacklisting
  reason TEXT NOT NULL,
  blocked_by INTEGER REFERENCES users(id), -- Admin who blocked

  -- Status
  is_active BOOLEAN DEFAULT true,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  -- Constraints: Must have at least email or phone
  CONSTRAINT check_has_identifier CHECK (
    email IS NOT NULL OR phone IS NOT NULL
  )
);

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_customer_blacklist_email ON customer_blacklist(email) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_customer_blacklist_phone ON customer_blacklist(phone) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_customer_blacklist_active ON customer_blacklist(is_active);

-- Trigger for updated_at
CREATE OR REPLACE FUNCTION update_customer_blacklist_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_customer_blacklist_updated_at ON customer_blacklist;
CREATE TRIGGER trigger_customer_blacklist_updated_at
  BEFORE UPDATE ON customer_blacklist
  FOR EACH ROW
  EXECUTE FUNCTION update_customer_blacklist_updated_at();

-- ========================================
-- 4. NEW: Customer Accounts System
-- ========================================

CREATE TABLE IF NOT EXISTS customers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Authentication (handled by Supabase Auth)
  auth_id UUID UNIQUE, -- Supabase auth.users.id

  -- Personal info
  email VARCHAR(255) UNIQUE NOT NULL,
  phone VARCHAR(50),
  first_name VARCHAR(100),
  last_name VARCHAR(100),

  -- Saved addresses (JSONB array)
  addresses JSONB DEFAULT '[]'::jsonb,
  default_address_index INTEGER DEFAULT 0,

  -- Preferences
  marketing_emails BOOLEAN DEFAULT false,
  sms_notifications BOOLEAN DEFAULT false,

  -- Account status
  is_verified BOOLEAN DEFAULT false,
  is_active BOOLEAN DEFAULT true,

  -- Stats (for loyalty program)
  total_orders INTEGER DEFAULT 0,
  total_spent DECIMAL(10, 2) DEFAULT 0,
  loyalty_points INTEGER DEFAULT 0,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  last_login_at TIMESTAMPTZ
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_customers_email ON customers(email);
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);
CREATE INDEX IF NOT EXISTS idx_customers_auth_id ON customers(auth_id);
CREATE INDEX IF NOT EXISTS idx_customers_active ON customers(is_active);

-- Updated trigger
CREATE OR REPLACE FUNCTION update_customers_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_customers_updated_at ON customers;
CREATE TRIGGER trigger_customers_updated_at
  BEFORE UPDATE ON customers
  FOR EACH ROW
  EXECUTE FUNCTION update_customers_updated_at();

-- Add customer_id to orders table if not exists
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES customers(id);

CREATE INDEX IF NOT EXISTS idx_orders_customer_id ON orders(customer_id);

-- ========================================
-- 5. NEW: Loyalty Program System
-- ========================================

CREATE TABLE IF NOT EXISTS loyalty_rules (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Rule configuration
  name VARCHAR(255) NOT NULL,
  description TEXT,

  -- Points earning
  points_per_euro DECIMAL(5, 2) DEFAULT 1.00, -- Points earned per € spent
  min_order_amount DECIMAL(10, 2) DEFAULT 0, -- Minimum order to earn points

  -- Multipliers for special conditions
  pickup_multiplier DECIMAL(3, 2) DEFAULT 1.00, -- Extra points for pickup
  delivery_multiplier DECIMAL(3, 2) DEFAULT 1.00,
  dine_in_multiplier DECIMAL(3, 2) DEFAULT 1.00,

  -- Bonus points for specific categories (JSONB)
  category_bonuses JSONB DEFAULT '{}'::jsonb, -- {"pizza": 2, "drinks": 0.5}

  -- Branch-specific rules
  branch_id INTEGER REFERENCES branches(id), -- NULL = applies to all branches

  -- Status
  is_active BOOLEAN DEFAULT true,
  priority INTEGER DEFAULT 0, -- Higher priority rules applied first

  -- Validity period
  valid_from TIMESTAMPTZ DEFAULT NOW(),
  valid_until TIMESTAMPTZ,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS loyalty_rewards (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Reward details
  name VARCHAR(255) NOT NULL,
  description TEXT,

  -- Cost in points
  points_required INTEGER NOT NULL,

  -- Reward type
  reward_type VARCHAR(50) NOT NULL CHECK (reward_type IN (
    'discount_percentage',
    'discount_fixed',
    'free_item',
    'free_delivery',
    'custom'
  )),

  -- Reward value
  discount_percentage DECIMAL(5, 2), -- For percentage discounts
  discount_amount DECIMAL(10, 2), -- For fixed amount discounts
  free_item_id INTEGER REFERENCES menu_items(id), -- For free item rewards
  custom_data JSONB, -- For custom rewards

  -- Restrictions
  min_order_amount DECIMAL(10, 2) DEFAULT 0,
  max_uses_per_customer INTEGER, -- NULL = unlimited
  max_total_uses INTEGER, -- NULL = unlimited
  current_uses INTEGER DEFAULT 0,

  -- Branch restrictions
  allowed_branches INTEGER[], -- NULL = all branches

  -- Order type restrictions
  pickup_only BOOLEAN DEFAULT false,
  delivery_only BOOLEAN DEFAULT false,
  dine_in_only BOOLEAN DEFAULT false,

  -- Status
  is_active BOOLEAN DEFAULT true,

  -- Validity
  valid_from TIMESTAMPTZ DEFAULT NOW(),
  valid_until TIMESTAMPTZ,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS loyalty_transactions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,

  -- Transaction details
  transaction_type VARCHAR(50) NOT NULL CHECK (transaction_type IN (
    'earned', 'redeemed', 'expired', 'adjusted', 'bonus'
  )),

  points INTEGER NOT NULL, -- Positive for earning, negative for redemption
  balance_after INTEGER NOT NULL, -- Points balance after this transaction

  -- Related entities
  order_id INTEGER REFERENCES orders(id),
  reward_id UUID REFERENCES loyalty_rewards(id),

  -- Description
  description TEXT,

  -- Metadata
  metadata JSONB DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_loyalty_transactions_customer ON loyalty_transactions(customer_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_transactions_order ON loyalty_transactions(order_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_transactions_created ON loyalty_transactions(created_at DESC);

-- Function to update customer loyalty points
CREATE OR REPLACE FUNCTION update_customer_loyalty_points()
RETURNS TRIGGER AS $$
BEGIN
  -- Update customer's loyalty_points
  UPDATE customers
  SET loyalty_points = (
    SELECT COALESCE(SUM(points), 0)
    FROM loyalty_transactions
    WHERE customer_id = NEW.customer_id
  )
  WHERE id = NEW.customer_id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_customer_loyalty_points ON loyalty_transactions;
CREATE TRIGGER trigger_update_customer_loyalty_points
  AFTER INSERT ON loyalty_transactions
  FOR EACH ROW
  EXECUTE FUNCTION update_customer_loyalty_points();

-- ========================================
-- 6. NEW: Coupon Codes System
-- ========================================

CREATE TABLE IF NOT EXISTS coupon_codes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Code details
  code VARCHAR(50) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT,

  -- Discount configuration
  discount_type VARCHAR(50) NOT NULL CHECK (discount_type IN (
    'percentage', 'fixed', 'free_delivery', 'free_item'
  )),
  discount_value DECIMAL(10, 2), -- Percentage or fixed amount
  free_item_id INTEGER REFERENCES menu_items(id),

  -- Restrictions
  min_order_amount DECIMAL(10, 2) DEFAULT 0,
  max_discount_amount DECIMAL(10, 2), -- Cap for percentage discounts

  -- Usage limits
  max_uses_total INTEGER, -- NULL = unlimited
  max_uses_per_customer INTEGER DEFAULT 1,
  current_uses INTEGER DEFAULT 0,

  -- Customer restrictions
  new_customers_only BOOLEAN DEFAULT false,
  specific_customers UUID[], -- Array of customer IDs, NULL = all

  -- Branch restrictions
  allowed_branches INTEGER[], -- NULL = all branches

  -- Order type restrictions
  pickup_only BOOLEAN DEFAULT false,
  delivery_only BOOLEAN DEFAULT false,
  dine_in_only BOOLEAN DEFAULT false,

  -- Category restrictions
  allowed_categories UUID[], -- NULL = all categories
  excluded_categories UUID[],

  -- Validity period
  valid_from TIMESTAMPTZ DEFAULT NOW(),
  valid_until TIMESTAMPTZ,

  -- Status
  is_active BOOLEAN DEFAULT true,

  -- Metadata for marketing tracking
  campaign_id VARCHAR(100), -- For tracking marketing campaigns
  utm_source VARCHAR(100),
  utm_medium VARCHAR(100),
  utm_campaign VARCHAR(100),

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS coupon_usage (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  coupon_id UUID NOT NULL REFERENCES coupon_codes(id) ON DELETE CASCADE,
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,

  -- Usage details
  discount_applied DECIMAL(10, 2) NOT NULL,

  -- Customer info (captured at time of use)
  customer_email VARCHAR(255),
  customer_phone VARCHAR(50),

  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_coupon_codes_code ON coupon_codes(code) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_coupon_codes_active ON coupon_codes(is_active);
CREATE INDEX IF NOT EXISTS idx_coupon_codes_campaign ON coupon_codes(campaign_id);
CREATE INDEX IF NOT EXISTS idx_coupon_usage_coupon ON coupon_usage(coupon_id);
CREATE INDEX IF NOT EXISTS idx_coupon_usage_customer ON coupon_usage(customer_id);
CREATE INDEX IF NOT EXISTS idx_coupon_usage_order ON coupon_usage(order_id);

-- Function to increment coupon usage
CREATE OR REPLACE FUNCTION increment_coupon_usage()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE coupon_codes
  SET current_uses = current_uses + 1
  WHERE id = NEW.coupon_id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_increment_coupon_usage ON coupon_usage;
CREATE TRIGGER trigger_increment_coupon_usage
  AFTER INSERT ON coupon_usage
  FOR EACH ROW
  EXECUTE FUNCTION increment_coupon_usage();

-- ========================================
-- 7. ENHANCE: Branch-Specific Payment Methods
-- ========================================

CREATE TABLE IF NOT EXISTS branch_payment_methods (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,

  -- Payment method configuration (JSONB array like in restaurant_settings)
  payment_methods JSONB NOT NULL DEFAULT '[
    {"id": "cash", "name": "Cash", "nameEn": "Cash", "enabled": true},
    {"id": "card", "name": "Korttimaksu", "nameEn": "Card Payment", "enabled": true},
    {"id": "online", "name": "Verkkopankki", "nameEn": "Online Banking", "enabled": false}
  ]'::jsonb,

  -- Stripe configuration (branch-specific if needed)
  stripe_enabled BOOLEAN DEFAULT false,
  stripe_connect_account_id VARCHAR(255), -- For Stripe Connect multi-account setup

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(branch_id)
);

CREATE INDEX IF NOT EXISTS idx_branch_payment_methods_branch ON branch_payment_methods(branch_id);

-- ========================================
-- 8. NEW: Multi-Brand Phone Numbers
-- ========================================

CREATE TABLE IF NOT EXISTS brand_phone_numbers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Brand/Branch identification
  brand_name VARCHAR(255) NOT NULL,
  branch_id INTEGER REFERENCES branches(id), -- NULL = brand-level, not branch-specific

  -- Phone details
  phone_number VARCHAR(50) NOT NULL,
  phone_label VARCHAR(100), -- e.g., "Customer Service", "Reservations", "Delivery"
  phone_label_en VARCHAR(100),

  -- Display settings
  is_primary BOOLEAN DEFAULT false,
  display_order INTEGER DEFAULT 0,

  -- Icons/styling
  icon VARCHAR(50) DEFAULT 'phone', -- Icon name for UI

  -- Status
  is_active BOOLEAN DEFAULT true,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_brand_phone_numbers_active ON brand_phone_numbers(is_active);
CREATE INDEX IF NOT EXISTS idx_brand_phone_numbers_branch ON brand_phone_numbers(branch_id);
CREATE INDEX IF NOT EXISTS idx_brand_phone_numbers_display_order ON brand_phone_numbers(display_order);

-- ========================================
-- 9. ENHANCE: Orders Table for New Features
-- ========================================

-- Add columns to support new features
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS coupon_code_id UUID REFERENCES coupon_codes(id),
  ADD COLUMN IF NOT EXISTS coupon_discount DECIMAL(10, 2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS loyalty_points_earned INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS loyalty_points_redeemed INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS loyalty_reward_id UUID REFERENCES loyalty_rewards(id);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_orders_coupon ON orders(coupon_code_id);
CREATE INDEX IF NOT EXISTS idx_orders_loyalty_reward ON orders(loyalty_reward_id);

-- ========================================
-- 10. SEED DATA
-- ========================================

-- Insert default loyalty rule
INSERT INTO loyalty_rules (
  name,
  description,
  points_per_euro,
  min_order_amount,
  is_active
) VALUES (
  'Default Loyalty Program',
  'Earn 1 point for every euro spent',
  1.00,
  0,
  true
) ON CONFLICT DO NOTHING;

-- Insert example loyalty rewards
INSERT INTO loyalty_rewards (
  name,
  description,
  points_required,
  reward_type,
  discount_percentage,
  is_active
) VALUES
  (
    '5% Discount',
    'Get 5% off your order',
    100,
    'discount_percentage',
    5,
    true
  ),
  (
    '10€ Discount',
    'Get 10€ off your order',
    200,
    'discount_fixed',
    NULL,
    true
  ),
  (
    'Free Delivery',
    'Get free delivery on your order',
    150,
    'free_delivery',
    NULL,
    true
  )
ON CONFLICT DO NOTHING;

-- ========================================
-- 11. VIEWS FOR REPORTING
-- ========================================

-- Customer lifetime value view
CREATE OR REPLACE VIEW customer_lifetime_value AS
SELECT
  c.id,
  c.email,
  c.first_name,
  c.last_name,
  c.total_orders,
  c.total_spent,
  c.loyalty_points,
  c.created_at as customer_since,
  COUNT(o.id) as verified_order_count,
  COALESCE(SUM(o.total_amount), 0) as verified_total_spent,
  COALESCE(AVG(o.total_amount), 0) as avg_order_value,
  MAX(o.created_at) as last_order_date
FROM customers c
LEFT JOIN orders o ON o.customer_id = c.id AND o.status != 'cancelled'
GROUP BY c.id;

-- Coupon performance view
CREATE OR REPLACE VIEW coupon_performance AS
SELECT
  cc.id,
  cc.code,
  cc.name,
  cc.discount_type,
  cc.discount_value,
  cc.max_uses_total,
  cc.current_uses,
  cc.valid_from,
  cc.valid_until,
  cc.is_active,
  COUNT(cu.id) as actual_uses,
  COALESCE(SUM(cu.discount_applied), 0) as total_discount_given,
  COALESCE(SUM(o.total_amount), 0) as total_revenue_with_coupon,
  COALESCE(AVG(o.total_amount), 0) as avg_order_value_with_coupon
FROM coupon_codes cc
LEFT JOIN coupon_usage cu ON cu.coupon_id = cc.id
LEFT JOIN orders o ON o.id = cu.order_id
GROUP BY cc.id;

-- ========================================
-- 12. HELPER FUNCTIONS
-- ========================================

-- Function to check if customer is blacklisted
CREATE OR REPLACE FUNCTION is_customer_blacklisted(
  p_email VARCHAR DEFAULT NULL,
  p_phone VARCHAR DEFAULT NULL
)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM customer_blacklist
    WHERE is_active = true
    AND (
      (p_email IS NOT NULL AND email = p_email)
      OR
      (p_phone IS NOT NULL AND phone = p_phone)
    )
  );
END;
$$ LANGUAGE plpgsql;

-- Function to validate coupon code
CREATE OR REPLACE FUNCTION validate_coupon_code(
  p_code VARCHAR,
  p_customer_id UUID DEFAULT NULL,
  p_branch_id INTEGER DEFAULT NULL,
  p_order_type VARCHAR DEFAULT NULL,
  p_order_amount DECIMAL DEFAULT 0
)
RETURNS TABLE (
  is_valid BOOLEAN,
  error_message TEXT,
  coupon_id UUID,
  discount_amount DECIMAL
) AS $$
DECLARE
  v_coupon coupon_codes%ROWTYPE;
  v_usage_count INTEGER;
  v_discount DECIMAL;
BEGIN
  -- Find coupon
  SELECT * INTO v_coupon
  FROM coupon_codes
  WHERE code = p_code AND is_active = true;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'Invalid coupon code'::TEXT, NULL::UUID, 0::DECIMAL;
    RETURN;
  END IF;

  -- Check validity period
  IF v_coupon.valid_from > NOW() THEN
    RETURN QUERY SELECT false, 'Coupon not yet valid'::TEXT, NULL::UUID, 0::DECIMAL;
    RETURN;
  END IF;

  IF v_coupon.valid_until IS NOT NULL AND v_coupon.valid_until < NOW() THEN
    RETURN QUERY SELECT false, 'Coupon has expired'::TEXT, NULL::UUID, 0::DECIMAL;
    RETURN;
  END IF;

  -- Check max uses
  IF v_coupon.max_uses_total IS NOT NULL AND v_coupon.current_uses >= v_coupon.max_uses_total THEN
    RETURN QUERY SELECT false, 'Coupon has reached maximum uses'::TEXT, NULL::UUID, 0::DECIMAL;
    RETURN;
  END IF;

  -- Check per-customer usage
  IF p_customer_id IS NOT NULL AND v_coupon.max_uses_per_customer IS NOT NULL THEN
    SELECT COUNT(*) INTO v_usage_count
    FROM coupon_usage
    WHERE coupon_id = v_coupon.id AND customer_id = p_customer_id;

    IF v_usage_count >= v_coupon.max_uses_per_customer THEN
      RETURN QUERY SELECT false, 'You have already used this coupon'::TEXT, NULL::UUID, 0::DECIMAL;
      RETURN;
    END IF;
  END IF;

  -- Check minimum order amount
  IF p_order_amount < v_coupon.min_order_amount THEN
    RETURN QUERY SELECT
      false,
      format('Minimum order amount is €%s', v_coupon.min_order_amount)::TEXT,
      NULL::UUID,
      0::DECIMAL;
    RETURN;
  END IF;

  -- Check branch restrictions
  IF v_coupon.allowed_branches IS NOT NULL AND p_branch_id IS NOT NULL THEN
    IF NOT (p_branch_id = ANY(v_coupon.allowed_branches)) THEN
      RETURN QUERY SELECT false, 'Coupon not valid for this branch'::TEXT, NULL::UUID, 0::DECIMAL;
      RETURN;
    END IF;
  END IF;

  -- Check order type restrictions
  IF p_order_type IS NOT NULL THEN
    IF v_coupon.pickup_only AND p_order_type != 'pickup' THEN
      RETURN QUERY SELECT false, 'Coupon only valid for pickup orders'::TEXT, NULL::UUID, 0::DECIMAL;
      RETURN;
    END IF;
    IF v_coupon.delivery_only AND p_order_type != 'delivery' THEN
      RETURN QUERY SELECT false, 'Coupon only valid for delivery orders'::TEXT, NULL::UUID, 0::DECIMAL;
      RETURN;
    END IF;
    IF v_coupon.dine_in_only AND p_order_type != 'dine_in' THEN
      RETURN QUERY SELECT false, 'Coupon only valid for dine-in orders'::TEXT, NULL::UUID, 0::DECIMAL;
      RETURN;
    END IF;
  END IF;

  -- Calculate discount
  IF v_coupon.discount_type = 'percentage' THEN
    v_discount := p_order_amount * (v_coupon.discount_value / 100);
    IF v_coupon.max_discount_amount IS NOT NULL THEN
      v_discount := LEAST(v_discount, v_coupon.max_discount_amount);
    END IF;
  ELSIF v_coupon.discount_type = 'fixed' THEN
    v_discount := LEAST(v_coupon.discount_value, p_order_amount);
  ELSIF v_coupon.discount_type = 'free_delivery' THEN
    v_discount := 0; -- Handled separately in application logic
  END IF;

  -- Valid!
  RETURN QUERY SELECT true, ''::TEXT, v_coupon.id, v_discount;
END;
$$ LANGUAGE plpgsql;

-- ========================================
-- END OF MIGRATION
-- ========================================

-- Grant permissions
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated;
