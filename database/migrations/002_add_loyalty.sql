-- Helmies Bites Loyalty Program Migration
-- Adds loyalty rewards, transactions, and customer points

-- ==========================================
-- 1. ADD LOYALTY_POINTS TO CUSTOMERS
-- ==========================================

ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS loyalty_points INTEGER DEFAULT 0;
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS auth_user_id UUID UNIQUE;

-- ==========================================
-- 2. LOYALTY REWARDS TABLE
-- ==========================================

CREATE TABLE IF NOT EXISTS public.loyalty_rewards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES public.tenants(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  name_en VARCHAR(255),
  description TEXT,
  points_required INTEGER NOT NULL CHECK (points_required > 0),
  discount_type VARCHAR(20) NOT NULL CHECK (discount_type IN ('percentage', 'fixed')),
  discount_value DECIMAL(10,2) NOT NULL DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_loyalty_rewards_tenant ON public.loyalty_rewards(tenant_id);

COMMENT ON TABLE public.loyalty_rewards IS 'Available loyalty rewards that customers can redeem';

-- ==========================================
-- 3. LOYALTY TRANSACTIONS TABLE
-- ==========================================

CREATE TABLE IF NOT EXISTS public.loyalty_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id INTEGER REFERENCES public.customers(id) ON DELETE CASCADE,
  points INTEGER NOT NULL,
  type VARCHAR(20) NOT NULL CHECK (type IN ('earned', 'redeemed')),
  description TEXT,
  order_id UUID,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_loyalty_transactions_customer ON public.loyalty_transactions(customer_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_transactions_created ON public.loyalty_transactions(created_at DESC);

COMMENT ON TABLE public.loyalty_transactions IS 'History of loyalty point earnings and redemptions';

-- ==========================================
-- 4. PROMOTIONS TABLE
-- ==========================================

CREATE TABLE IF NOT EXISTS public.promotions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES public.tenants(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  name_en VARCHAR(255),
  description TEXT,
  description_en TEXT,
  discount_type VARCHAR(20) NOT NULL CHECK (discount_type IN ('percentage', 'fixed', 'free_item')),
  discount_value DECIMAL(10,2) NOT NULL DEFAULT 0,
  min_order_amount DECIMAL(10,2) DEFAULT 0,
  max_uses INTEGER,
  current_uses INTEGER DEFAULT 0,
  start_date TIMESTAMPTZ,
  end_date TIMESTAMPTZ,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_promotions_tenant ON public.promotions(tenant_id);

COMMENT ON TABLE public.promotions IS 'Time-limited promotional offers for restaurants';

-- ==========================================
-- 5. BLACKLIST TABLE
-- ==========================================

CREATE TABLE IF NOT EXISTS public.blacklist (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES public.tenants(id) ON DELETE CASCADE,
  phone VARCHAR(50),
  email VARCHAR(255),
  reason TEXT,
  blocked_by UUID,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_blacklist_tenant ON public.blacklist(tenant_id);
CREATE INDEX IF NOT EXISTS idx_blacklist_phone ON public.blacklist(phone);
CREATE INDEX IF NOT EXISTS idx_blacklist_email ON public.blacklist(email);

COMMENT ON TABLE public.blacklist IS 'Blocked customers by phone or email';
