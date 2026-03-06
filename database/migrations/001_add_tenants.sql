-- Helmies Bites Multi-Tenant Migration
-- This migration adds tenant support to the existing Babylon schema

-- ==========================================
-- 1. CORE TENANTS TABLE
-- ==========================================

CREATE TABLE IF NOT EXISTS public.tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug VARCHAR(100) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  name_en VARCHAR(255),
  description TEXT,
  description_en TEXT,

  -- Subscription & Pricing
  status VARCHAR(50) DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'suspended', 'cancelled')),
  subscription_tier VARCHAR(50) DEFAULT 'starter' CHECK (subscription_tier IN ('starter', 'pro', 'enterprise')),

  -- Stripe Integration (Helmies managed)
  stripe_customer_id VARCHAR(255),
  helmies_fee_percentage DECIMAL(5,2) DEFAULT 5.00,
  monthly_fee DECIMAL(10,2) DEFAULT 0,

  -- Feature Flags
  features JSONB DEFAULT '{
    "cashOnDelivery": false,
    "aiAssistant": false,
    "delivery": true,
    "pickup": true,
    "lunch": false,
    "multiBranch": false
  }'::jsonb,

  -- Metadata
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE public.tenants IS 'Multi-tenant restaurant registry';
COMMENT ON COLUMN public.tenants.slug IS 'Subdomain prefix (e.g., ravbabylon for ravbabylon.helmiesbites.fi)';
COMMENT ON COLUMN public.tenants.status IS 'pending: wizard incomplete, active: live, suspended: payment issue, cancelled: closed';

-- ==========================================
-- 2. ADD TENANT_ID TO EXISTING TABLES
-- ==========================================

-- Users table
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_users_tenant_id ON public.users(tenant_id);

-- Branches table
ALTER TABLE public.branches ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_branches_tenant_id ON public.branches(tenant_id);

-- Categories table
ALTER TABLE public.categories ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_categories_tenant_id ON public.categories(tenant_id);

-- Menu items table
ALTER TABLE public.menu_items ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_menu_items_tenant_id ON public.menu_items(tenant_id);

-- Orders table
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_orders_tenant_id ON public.orders(tenant_id);

-- Restaurant config table
ALTER TABLE public.restaurant_config ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_restaurant_config_tenant_id ON public.restaurant_config(tenant_id);

-- Customers table
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_customers_tenant_id ON public.customers(tenant_id);

-- Promotions table (only if exists)
DO $$ BEGIN
  ALTER TABLE public.promotions ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id) ON DELETE CASCADE;
  CREATE INDEX IF NOT EXISTS idx_promotions_tenant_id ON public.promotions(tenant_id);
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

-- Coupons table (only if exists)
DO $$ BEGIN
  ALTER TABLE public.coupons ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id) ON DELETE CASCADE;
  CREATE INDEX IF NOT EXISTS idx_coupons_tenant_id ON public.coupons(tenant_id);
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

-- Lounas menus table (only if exists)
DO $$ BEGIN
  ALTER TABLE public.lounas_menus ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id) ON DELETE CASCADE;
  CREATE INDEX IF NOT EXISTS idx_lounas_menus_tenant_id ON public.lounas_menus(tenant_id);
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

-- Lounas settings table (only if exists)
DO $$ BEGIN
  ALTER TABLE public.lounas_settings ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id) ON DELETE CASCADE;
  CREATE INDEX IF NOT EXISTS idx_lounas_settings_tenant_id ON public.lounas_settings(tenant_id);
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

-- ==========================================
-- 3. WIZARD SESSIONS TABLE
-- ==========================================

CREATE TABLE IF NOT EXISTS public.wizard_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES public.tenants(id) ON DELETE SET NULL,
  email VARCHAR(255) NOT NULL,
  step VARCHAR(50) DEFAULT 'restaurant-info',
  data JSONB DEFAULT '{}',
  status VARCHAR(50) DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed', 'abandoned')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE public.wizard_sessions IS 'Onboarding wizard session state';
COMMENT ON COLUMN public.wizard_sessions.data IS 'Accumulated wizard data (restaurant info, menu, theme, etc.)';
COMMENT ON COLUMN public.wizard_sessions.step IS 'Current wizard step: restaurant-info, menu-upload, images, theme, domain, stripe, review';

CREATE INDEX IF NOT EXISTS idx_wizard_sessions_email ON public.wizard_sessions(email);
CREATE INDEX IF NOT EXISTS idx_wizard_sessions_status ON public.wizard_sessions(status);

-- ==========================================
-- 4. ONBOARDING AUTOMATION TASKS
-- ==========================================

CREATE TABLE IF NOT EXISTS public.onboarding_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES public.tenants(id) ON DELETE CASCADE,
  task_type VARCHAR(100) NOT NULL,
  status VARCHAR(50) DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'failed')),
  data JSONB DEFAULT '{}',
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE public.onboarding_tasks IS 'Automation task tracking for restaurant onboarding';
COMMENT ON COLUMN public.onboarding_tasks.task_type IS 'github_repo, vercel_deploy, email_account, domain_setup, stripe_setup';

CREATE INDEX IF NOT EXISTS idx_onboarding_tasks_tenant_id ON public.onboarding_tasks(tenant_id);
CREATE INDEX IF NOT EXISTS idx_onboarding_tasks_status ON public.onboarding_tasks(status);

-- ==========================================
-- 5. TENANT DOMAINS
-- ==========================================

CREATE TABLE IF NOT EXISTS public.tenant_domains (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES public.tenants(id) ON DELETE CASCADE,
  domain_type VARCHAR(50) NOT NULL CHECK (domain_type IN ('subdomain', 'path', 'custom', 'temporary')),
  domain VARCHAR(255) NOT NULL,
  is_primary BOOLEAN DEFAULT FALSE,
  ssl_status VARCHAR(50) DEFAULT 'pending' CHECK (ssl_status IN ('pending', 'active', 'failed')),
  dns_verified BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tenant_id, domain)
);

COMMENT ON TABLE public.tenant_domains IS 'Tenant domain configurations';
COMMENT ON COLUMN public.tenant_domains.domain_type IS 'subdomain: restaurant.helmiesbites.fi, path: helmiesbites.fi/restaurant, custom: own domain, temporary: temp.helmiesbites.fi';

CREATE INDEX IF NOT EXISTS idx_tenant_domains_tenant_id ON public.tenant_domains(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenant_domains_domain ON public.tenant_domains(domain);

-- ==========================================
-- 6. AI CREDITS TRACKING
-- ==========================================

CREATE TABLE IF NOT EXISTS public.ai_credits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES public.tenants(id) ON DELETE CASCADE,
  credit_type VARCHAR(50) NOT NULL CHECK (credit_type IN ('menu_images', 'branding', 'assistant', 'translation')),
  amount INTEGER NOT NULL,
  cost DECIMAL(10,2) NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE public.ai_credits IS 'AI service usage tracking for billing';
COMMENT ON COLUMN public.ai_credits.credit_type IS 'menu_images: €20, branding: €5, assistant: €10/mo, translation: per use';

CREATE INDEX IF NOT EXISTS idx_ai_credits_tenant_id ON public.ai_credits(tenant_id);
CREATE INDEX IF NOT EXISTS idx_ai_credits_type ON public.ai_credits(credit_type);

-- ==========================================
-- 7. THEME PRESETS
-- ==========================================

CREATE TABLE IF NOT EXISTS public.theme_presets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  name_en VARCHAR(100),
  description TEXT,
  theme JSONB NOT NULL,
  preview_image_url TEXT,
  category VARCHAR(50) DEFAULT 'modern',
  is_active BOOLEAN DEFAULT TRUE,
  display_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE public.theme_presets IS 'Pre-built theme options for restaurant websites';

CREATE INDEX IF NOT EXISTS idx_theme_presets_active ON public.theme_presets(is_active);
CREATE INDEX IF NOT EXISTS idx_theme_presets_category ON public.theme_presets(category);

-- Insert default theme presets
INSERT INTO public.theme_presets (name, name_en, theme, category, display_order) VALUES
(
  'Modern Orange',
  'Modern Orange',
  '{
    "primary": "#FF8C00",
    "secondary": "#8B4513",
    "accent": "#F5E6D3",
    "light": {
      "background": "#ffffff",
      "foreground": "#1f2937",
      "card": "#ffffff",
      "primary": "#FF8C00"
    },
    "dark": {
      "background": "#1f2937",
      "foreground": "#f9fafb",
      "card": "#374151",
      "primary": "#FF8C00"
    }
  }'::jsonb,
  'modern',
  1
),
(
  'Elegant Dark',
  'Elegant Dark',
  '{
    "primary": "#D4AF37",
    "secondary": "#1a1a1a",
    "accent": "#2d2d2d",
    "light": {
      "background": "#ffffff",
      "foreground": "#1a1a1a",
      "card": "#f5f5f5",
      "primary": "#D4AF37"
    },
    "dark": {
      "background": "#0a0a0a",
      "foreground": "#e5e5e5",
      "card": "#1a1a1a",
      "primary": "#D4AF37"
    }
  }'::jsonb,
  'elegant',
  2
),
(
  'Fresh Green',
  'Fresh Green',
  '{
    "primary": "#22c55e",
    "secondary": "#15803d",
    "accent": "#dcfce7",
    "light": {
      "background": "#ffffff",
      "foreground": "#1f2937",
      "card": "#ffffff",
      "primary": "#22c55e"
    },
    "dark": {
      "background": "#1f2937",
      "foreground": "#f9fafb",
      "card": "#374151",
      "primary": "#22c55e"
    }
  }'::jsonb,
  'fresh',
  3
),
(
  'Ocean Blue',
  'Ocean Blue',
  '{
    "primary": "#3b82f6",
    "secondary": "#1d4ed8",
    "accent": "#dbeafe",
    "light": {
      "background": "#ffffff",
      "foreground": "#1f2937",
      "card": "#ffffff",
      "primary": "#3b82f6"
    },
    "dark": {
      "background": "#1e3a8a",
      "foreground": "#f9fafb",
      "card": "#1e40af",
      "primary": "#60a5fa"
    }
  }'::jsonb,
  'modern',
  4
),
(
  'Rustic Warm',
  'Rustic Warm',
  '{
    "primary": "#b45309",
    "secondary": "#78350f",
    "accent": "#fed7aa",
    "light": {
      "background": "#fffbeb",
      "foreground": "#1f2937",
      "card": "#ffffff",
      "primary": "#b45309"
    },
    "dark": {
      "background": "#292524",
      "foreground": "#fafaf9",
      "card": "#44403c",
      "primary": "#d97706"
    }
  }'::jsonb,
  'rustic',
  5
)
ON CONFLICT DO NOTHING;

-- ==========================================
-- 8. SUPPORT TICKETS
-- ==========================================

CREATE TABLE IF NOT EXISTS public.support_tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES public.tenants(id) ON DELETE CASCADE,
  subject VARCHAR(255) NOT NULL,
  message TEXT NOT NULL,
  status VARCHAR(50) DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
  priority VARCHAR(50) DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  assigned_to UUID,
  resolution TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE public.support_tickets IS 'Restaurant support request tickets';

CREATE INDEX IF NOT EXISTS idx_support_tickets_tenant_id ON public.support_tickets(tenant_id);
CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON public.support_tickets(status);
CREATE INDEX IF NOT EXISTS idx_support_tickets_priority ON public.support_tickets(priority);

-- ==========================================
-- 9. EMAIL TEMPLATES
-- ==========================================

CREATE TABLE IF NOT EXISTS public.email_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_type VARCHAR(100) NOT NULL UNIQUE,
  subject_fi VARCHAR(255),
  subject_en VARCHAR(255),
  subject_sv VARCHAR(255),
  body_html_fi TEXT,
  body_html_en TEXT,
  body_html_sv TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE public.email_templates IS 'Transactional email templates';

CREATE INDEX IF NOT EXISTS idx_email_templates_type ON public.email_templates(template_type);

-- Insert default email templates
INSERT INTO public.email_templates (template_type, subject_en, subject_fi, body_html_en, body_html_fi) VALUES
(
  'welcome',
  'Welcome to Helmies Bites! 🍽️',
  'Tervetuloa Helmies Bitesiin! 🍽️',
  '<html>
<body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
  <div style="background: linear-gradient(135deg, #FF8C00 0%, #8B4513 100%); padding: 30px; text-align: center;">
    <h1 style="color: white; margin: 0;">Welcome to Helmies Bites!</h1>
  </div>
  <div style="padding: 30px; background: #f9f9f9;">
    <h2>Your restaurant is now live!</h2>
    <p>Hi {{restaurantName}},</p>
    <p>Congratulations! Your restaurant website is now ready. Here are your login credentials:</p>
    <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0;">
      <p><strong>Email:</strong> {{email}}</p>
      <p><strong>Password:</strong> {{password}}</p>
    </div>
    <p>Admin Dashboard: <a href="{{adminUrl}}">{{adminUrl}}</a></p>
    <p>Your Website: <a href="{{siteUrl}}">{{siteUrl}}</a></p>
    <p>You can now start receiving orders!</p>
  </div>
</body>
</html>',
  '<html>
<body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
  <div style="background: linear-gradient(135deg, #FF8C00 0%, #8B4513 100%); padding: 30px; text-align: center;">
    <h1 style="color: white; margin: 0;">Tervetuloa Helmies Bitesiin!</h1>
  </div>
  <div style="padding: 30px; background: #f9f9f9;">
    <h2>Ravintolasi on nyt toiminnassa!</h2>
    <p>Hei {{restaurantName}},</p>
    <p>Onneksi olkoon! Ravintolasi verkkosivusto on nyt valmis. Tässä ovat kirjautumistietosi:</p>
    <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0;">
      <p><strong>Sähköposti:</strong> {{email}}</p>
      <p><strong>Salasana:</strong> {{password}}</p>
    </div>
    <p>Hallintapaneeli: <a href="{{adminUrl}}">{{adminUrl}}</a></p>
    <p>Verkkosivusto: <a href="{{siteUrl}}">{{siteUrl}}</a></p>
    <p>Voit nyt alkaa vastaanottaa tilauksia!</p>
  </div>
</body>
</html>'
),
(
  'password_reset',
  'Reset your password',
  'Nollaa salasanasi',
  '<html>
<body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
  <div style="background: linear-gradient(135deg, #FF8C00 0%, #8B4513 100%); padding: 30px; text-align: center;">
    <h1 style="color: white; margin: 0;">Password Reset</h1>
  </div>
  <div style="padding: 30px; background: #f9f9f9;">
    <p>Click the link below to reset your password:</p>
    <p><a href="{{resetLink}}">{{resetLink}}</a></p>
    <p>This link expires in 1 hour.</p>
  </div>
</body>
</html>',
  '<html>
<body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
  <div style="background: linear-gradient(135deg, #FF8C00 0%, #8B4513 100%); padding: 30px; text-align: center;">
    <h1 style="color: white; margin: 0;">Salasanan nollaus</h1>
  </div>
  <div style="padding: 30px; background: #f9f9f9;">
    <p>Napsauta alla olevaa linkkiä nollataksesi salasanasi:</p>
    <p><a href="{{resetLink}}">{{resetLink}}</a></p>
    <p>Tämä linkki vanhenee tunnissa.</p>
  </div>
</body>
</html>'
),
(
  'monthly_invoice',
  'Your Helmies Bites invoice for {{month}}',
  'Helmies Bites laskusi {{month}}',
  '<html>
<body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
  <div style="background: linear-gradient(135deg, #FF8C00 0%, #8B4513 100%); padding: 30px; text-align: center;">
    <h1 style="color: white; margin: 0;">Invoice</h1>
  </div>
  <div style="padding: 30px; background: #f9f9f9;">
    <h2>Invoice for {{month}} {{year}}</h2>
    <p><strong>Restaurant:</strong> {{restaurantName}}</p>
    <p><strong>Total Orders:</strong> {{orderCount}}</p>
    <p><strong>Service Fee (5%):</strong> €{{serviceFee}}</p>
    <p><strong>Monthly Fee:</strong> €{{monthlyFee}}</p>
    <p><strong>Total Due:</strong> €{{totalAmount}}</p>
    <p>Payment will be charged automatically.</p>
  </div>
</body>
</html>',
  '<html>
<body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
  <div style="background: linear-gradient(135deg, #FF8C00 0%, #8B4513 100%); padding: 30px; text-align: center;">
    <h1 style="color: white; margin: 0;">Lasku</h1>
  </div>
  <div style="padding: 30px; background: #f9f9f9;">
    <h2>Lasku {{month}} {{year}}</h2>
    <p><strong>Ravintola:</strong> {{restaurantName}}</p>
    <p><strong>Tilaukset yhteensä:</strong> {{orderCount}}</p>
    <p><strong>Palvelumaksu (5%):</strong> €{{serviceFee}}</p>
    <p><strong>Kuukausimaksu:</strong> €{{monthlyFee}}</p>
    <p><strong>Yhteensä:</strong> €{{totalAmount}}</p>
    <p>Maksu veloitetaan automaattisesti.</p>
  </div>
</body>
</html>'
)
ON CONFLICT DO NOTHING;

-- ==========================================
-- 10. HELPER FUNCTIONS FOR TENANT ISOLATION
-- ==========================================

-- Check if the current user is an admin
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN AS $$
BEGIN
  RETURN COALESCE(
    current_setting('request.jwt.claims', true)::json->>'role' = 'admin',
    FALSE
  );
EXCEPTION WHEN OTHERS THEN
  RETURN FALSE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Get current tenant ID from JWT claims
CREATE OR REPLACE FUNCTION public.current_tenant_id()
RETURNS UUID AS $$
BEGIN
  RETURN current_setting('request.jwt.claims', true)::json->>'tenant_id'::UUID;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Get tenant from subdomain
CREATE OR REPLACE FUNCTION public.tenant_from_subdomain(host TEXT)
RETURNS UUID AS $$
DECLARE
  subdomain TEXT;
  tenant_id UUID;
BEGIN
  -- Extract subdomain (first part before dot)
  subdomain := split_part(host, '.', 1);

  -- Skip if it's the main domain
  IF subdomain IN ('helmiesbites', 'bites', 'www', 'admin', 'api') THEN
    RETURN NULL;
  END IF;

  -- Look up tenant
  SELECT id INTO tenant_id FROM public.tenants
  WHERE slug = subdomain AND status = 'active';

  RETURN tenant_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Set tenant context for request
CREATE OR REPLACE FUNCTION public.set_tenant_context()
RETURNS void AS $$
DECLARE
  tenant_id UUID;
BEGIN
  -- Try to get tenant from subdomain
  tenant_id := public.tenant_from_subdomain(current_setting('request.header.host', true));

  IF tenant_id IS NOT NULL THEN
    PERFORM set_config('app.current_tenant', tenant_id::TEXT, false);
  END IF;
END;
$$ LANGUAGE plpgsql;

-- ==========================================
-- 11. UPDATE TRIGGERS FOR NEW TABLES
-- ==========================================

-- Auto-update updated_at timestamp
CREATE TRIGGER update_tenants_updated_at
  BEFORE UPDATE ON public.tenants
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_wizard_sessions_updated_at
  BEFORE UPDATE ON public.wizard_sessions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_onboarding_tasks_updated_at
  BEFORE UPDATE ON public.onboarding_tasks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_support_tickets_updated_at
  BEFORE UPDATE ON public.support_tickets
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_email_templates_updated_at
  BEFORE UPDATE ON public.email_templates
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ==========================================
-- 12. ROW LEVEL SECURITY POLICIES FOR TENANTS
-- ==========================================

-- Enable RLS on new tables
ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wizard_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.onboarding_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_credits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.theme_presets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_templates ENABLE ROW LEVEL SECURITY;

-- Tenants table policies
CREATE POLICY "Service role can manage all tenants" ON public.tenants
  FOR ALL USING (current_setting('app.is_service_role', true)::boolean = true);

CREATE POLICY "Tenants can view own profile" ON public.tenants
  FOR SELECT USING (id = current_tenant_id());

-- Wizard sessions policies
CREATE POLICY "Service role can manage all wizard sessions" ON public.wizard_sessions
  FOR ALL USING (current_setting('app.is_service_role', true)::boolean = true);

CREATE POLICY "Users can access own wizard session" ON public.wizard_sessions
  FOR ALL USING (email = current_setting('request.jwt.claims', true)::json->>'email');

-- Onboarding tasks policies
CREATE POLICY "Service role can manage all onboarding tasks" ON public.onboarding_tasks
  FOR ALL USING (current_setting('app.is_service_role', true)::boolean = true);

CREATE POLICY "Tenants can view own onboarding tasks" ON public.onboarding_tasks
  FOR SELECT USING (tenant_id = current_tenant_id());

-- Tenant domains policies
CREATE POLICY "Service role can manage all tenant domains" ON public.tenant_domains
  FOR ALL USING (current_setting('app.is_service_role', true)::boolean = true);

CREATE POLICY "Tenants can view own domains" ON public.tenant_domains
  FOR SELECT USING (tenant_id = current_tenant_id());

-- AI credits policies
CREATE POLICY "Service role can manage all ai credits" ON public.ai_credits
  FOR ALL USING (current_setting('app.is_service_role', true)::boolean = true);

CREATE POLICY "Tenants can view own ai credits" ON public.ai_credits
  FOR SELECT USING (tenant_id = current_tenant_id());

-- Theme presets policies (public read)
CREATE POLICY "Anyone can view active theme presets" ON public.theme_presets
  FOR SELECT USING (is_active = true);

CREATE POLICY "Service role can manage theme presets" ON public.theme_presets
  FOR ALL USING (current_setting('app.is_service_role', true)::boolean = true);

-- Support tickets policies
CREATE POLICY "Service role can manage all support tickets" ON public.support_tickets
  FOR ALL USING (current_setting('app.is_service_role', true)::boolean = true);

CREATE POLICY "Tenants can manage own support tickets" ON public.support_tickets
  FOR ALL USING (tenant_id = current_tenant_id());

-- Email templates policies
CREATE POLICY "Service role can manage email templates" ON public.email_templates
  FOR ALL USING (current_setting('app.is_service_role', true)::boolean = true);

CREATE POLICY "Anyone can use email templates" ON public.email_templates
  FOR SELECT USING (is_active = true);

-- ==========================================
-- 13. UPDATE EXISTING RLS POLICIES FOR TENANT ISOLATION
-- ==========================================

-- Update orders policy to include tenant_id
DROP POLICY IF EXISTS "Anyone can create orders" ON public.orders;
CREATE POLICY "Anyone can create orders" ON public.orders
  FOR INSERT WITH CHECK (tenant_id = current_tenant_id() OR tenant_id IS NULL);

DROP POLICY IF EXISTS "Customers can view own orders" ON public.orders;
CREATE POLICY "Customers can view own orders" ON public.orders
  FOR SELECT USING (
    (customer_phone = current_setting('request.header.customer-phone', true) OR
    customer_email = current_setting('request.header.customer-email', true))
    AND (tenant_id = current_tenant_id() OR tenant_id IS NULL)
  );

DROP POLICY IF EXISTS "Admin can manage all orders" ON public.orders;
CREATE POLICY "Admin can manage all orders" ON public.orders
  FOR ALL USING (
    public.is_admin() OR
    tenant_id = current_tenant_id()
  );

-- Update menu_items policy
DROP POLICY IF EXISTS "Anyone can view available menu items" ON public.menu_items;
CREATE POLICY "Anyone can view available menu items" ON public.menu_items
  FOR SELECT USING (
    is_available = true AND
    (tenant_id = current_tenant_id() OR tenant_id IS NULL)
  );

DROP POLICY IF EXISTS "Admin can manage menu items" ON public.menu_items;
CREATE POLICY "Admin can manage menu items" ON public.menu_items
  FOR ALL USING (
    public.is_admin() OR
    tenant_id = current_tenant_id()
  );

-- Update categories policy
DROP POLICY IF EXISTS "Anyone can view active categories" ON public.categories;
CREATE POLICY "Anyone can view active categories" ON public.categories
  FOR SELECT USING (
    is_active = true AND
    (tenant_id = current_tenant_id() OR tenant_id IS NULL)
  );

DROP POLICY IF EXISTS "Admin can manage categories" ON public.categories;
CREATE POLICY "Admin can manage categories" ON public.categories
  FOR ALL USING (
    public.is_admin() OR
    tenant_id = current_tenant_id()
  );

-- Update branches policy
DROP POLICY IF EXISTS "Anyone can view active branches" ON public.branches;
CREATE POLICY "Anyone can view active branches" ON public.branches
  FOR SELECT USING (
    is_active = true AND
    (tenant_id = current_tenant_id() OR tenant_id IS NULL)
  );

DROP POLICY IF EXISTS "Admin can manage branches" ON public.branches;
CREATE POLICY "Admin can manage branches" ON public.branches
  FOR ALL USING (
    public.is_admin() OR
    tenant_id = current_tenant_id()
  );

-- Update restaurant_config policy
DROP POLICY IF EXISTS "Anyone can read active restaurant config" ON public.restaurant_config;
CREATE POLICY "Anyone can read active restaurant config" ON public.restaurant_config
  FOR SELECT USING (
    is_active = true AND
    (tenant_id = current_tenant_id() OR tenant_id IS NULL)
  );

DROP POLICY IF EXISTS "Admin can manage restaurant config" ON public.restaurant_config;
CREATE POLICY "Admin can manage restaurant config" ON public.restaurant_config
  FOR ALL USING (
    public.is_admin() OR
    tenant_id = current_tenant_id()
  );

-- ==========================================
-- 14. GRANT PERMISSIONS
-- ==========================================

-- Grant usage on tenant sequences (if we add them later)
-- GRANT USAGE ON SEQUENCE public.tenants_id_seq TO authenticated;

-- Grant table permissions for authenticated users
GRANT SELECT ON public.tenants TO authenticated;
GRANT SELECT ON public.theme_presets TO authenticated;
GRANT SELECT ON public.email_templates TO authenticated;
GRANT SELECT, UPDATE ON public.wizard_sessions TO authenticated;
GRANT SELECT ON public.onboarding_tasks TO authenticated;
GRANT SELECT ON public.tenant_domains TO authenticated;
GRANT SELECT ON public.ai_credits TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.support_tickets TO authenticated;

-- Grant all permissions to service_role
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;

-- ==========================================
-- 15. CREATE VIEWS FOR EASY QUERIES
-- ==========================================

-- Active tenants view
CREATE OR REPLACE VIEW public.active_tenants AS
SELECT
  id,
  slug,
  name,
  name_en,
  status,
  subscription_tier,
  helmies_fee_percentage,
  monthly_fee,
  features,
  created_at
FROM public.tenants
WHERE status = 'active'
ORDER BY created_at DESC;

COMMENT ON VIEW public.active_tenants IS 'All active restaurant tenants';

-- Tenant statistics view
CREATE OR REPLACE VIEW public.tenant_statistics AS
SELECT
  t.id AS tenant_id,
  t.name AS tenant_name,
  t.slug,
  COUNT(DISTINCT o.id) AS total_orders,
  COALESCE(SUM(o.total_amount), 0) AS total_revenue,
  COUNT(DISTINCT b.id) AS branch_count,
  COUNT(DISTINCT mi.id) AS menu_item_count,
  t.created_at AS joined_date
FROM public.tenants t
LEFT JOIN public.orders o ON o.tenant_id = t.id
LEFT JOIN public.branches b ON b.tenant_id = t.id
LEFT JOIN public.menu_items mi ON mi.tenant_id = t.id
WHERE t.status = 'active'
GROUP BY t.id, t.name, t.slug, t.created_at;

COMMENT ON VIEW public.tenant_statistics IS 'Aggregated statistics per tenant';

-- Wizard progress view
CREATE OR REPLACE VIEW public.wizard_progress AS
SELECT
  ws.id AS session_id,
  ws.email,
  ws.step,
  ws.status,
  ws.data,
  ws.created_at AS started_at,
  ws.updated_at AS last_updated,
  COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'task_type', ot.task_type,
        'status', ot.status,
        'created_at', ot.created_at
      ) ORDER BY ot.created_at
    ) FILTER (WHERE ot.id IS NOT NULL),
    '[]'::jsonb
  ) AS onboarding_tasks
FROM public.wizard_sessions ws
LEFT JOIN public.onboarding_tasks ot ON ot.tenant_id = ws.tenant_id
GROUP BY ws.id, ws.email, ws.step, ws.status, ws.data, ws.created_at, ws.updated_at;

COMMENT ON VIEW public.wizard_progress IS 'Wizard session progress with automation tasks';

-- ==========================================
-- 16. CREATE FUNCTIONS FOR COMMON OPERATIONS
-- ==========================================

-- Get or create tenant by slug
CREATE OR REPLACE FUNCTION public.get_or_create_tenant(
  p_slug VARCHAR,
  p_name VARCHAR,
  p_email VARCHAR
)
RETURNS UUID AS $$
DECLARE
  v_tenant_id UUID;
BEGIN
  -- Try to find existing tenant
  SELECT id INTO v_tenant_id FROM public.tenants WHERE slug = p_slug;

  -- If not found, create new one
  IF v_tenant_id IS NULL THEN
    INSERT INTO public.tenants (slug, name, metadata)
    VALUES (p_slug, p_name, jsonb_build_object('contact_email', p_email))
    RETURNING id INTO v_tenant_id;
  END IF;

  RETURN v_tenant_id;
END;
$$ LANGUAGE plpgsql;

-- Calculate tenant monthly fee
CREATE OR REPLACE FUNCTION public.calculate_tenant_monthly_fee(tenant_uuid UUID)
RETURNS DECIMAL(10,2) AS $$
DECLARE
  v_fee DECIMAL(10,2) := 0;
  v_features JSONB;
BEGIN
  SELECT features INTO v_features FROM public.tenants WHERE id = tenant_uuid;

  -- Cash on Delivery: €30/month
  IF v_features->>'cashOnDelivery' = 'true' THEN
    v_fee := v_fee + 30;
  END IF;

  -- AI Assistant: €10/month
  IF v_features->>'aiAssistant' = 'true' THEN
    v_fee := v_fee + 10;
  END IF;

  RETURN v_fee;
END;
$$ LANGUAGE plpgsql;

-- Update tenant monthly fee
CREATE OR REPLACE FUNCTION public.update_tenant_monthly_fee(tenant_uuid UUID)
RETURNS VOID AS $$
BEGIN
  UPDATE public.tenants
  SET monthly_fee = public.calculate_tenant_monthly_fee(tenant_uuid),
    updated_at = NOW()
  WHERE id = tenant_uuid;
END;
$$ LANGUAGE plpgsql;

-- ==========================================
-- 17. SUPPORT MESSAGES TABLE
-- ==========================================

CREATE TABLE IF NOT EXISTS public.support_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID REFERENCES public.support_tickets(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  sender VARCHAR(255) NOT NULL,
  sender_type VARCHAR(50) DEFAULT 'tenant' CHECK (sender_type IN ('tenant', 'support', 'system')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE public.support_messages IS 'Support ticket message history';

CREATE INDEX IF NOT EXISTS idx_support_messages_ticket_id ON public.support_messages(ticket_id);

ALTER TABLE public.support_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role can manage all support messages" ON public.support_messages
  FOR ALL USING (current_setting('app.is_service_role', true)::boolean = true);

CREATE POLICY "Tenants can view own ticket messages" ON public.support_messages
  FOR SELECT USING (
    ticket_id IN (
      SELECT id FROM public.support_tickets WHERE tenant_id = current_tenant_id()
    )
  );

CREATE POLICY "Tenants can create messages" ON public.support_messages
  FOR INSERT WITH CHECK (
    ticket_id IN (
      SELECT id FROM public.support_tickets WHERE tenant_id = current_tenant_id()
    )
  );

-- ==========================================
-- 18. PAYOUTS TABLE
-- ==========================================

CREATE TABLE IF NOT EXISTS public.payouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES public.tenants(id) ON DELETE CASCADE,
  amount DECIMAL(10,2) NOT NULL,
  status VARCHAR(50) DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  bank_details JSONB DEFAULT '{}',
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE public.payouts IS 'Restaurant payout records';

CREATE INDEX IF NOT EXISTS idx_payouts_tenant_id ON public.payouts(tenant_id);
CREATE INDEX IF NOT EXISTS idx_payouts_status ON public.payouts(status);

ALTER TABLE public.payouts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role can manage all payouts" ON public.payouts
  FOR ALL USING (current_setting('app.is_service_role', true)::boolean = true);

CREATE POLICY "Tenants can view own payouts" ON public.payouts
  FOR SELECT USING (tenant_id = current_tenant_id());

-- ==========================================
-- 19. UPDATE ORDERS TABLE FOR PAYOUTS
-- ==========================================

-- Add payout tracking columns to orders
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS paid_out BOOLEAN DEFAULT false;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS payout_date TIMESTAMPTZ;

-- ==========================================
-- 20. UPDATE SUPPORT TICKETS STATUS
-- ==========================================

-- Add waiting status to support_tickets check constraint
ALTER TABLE public.support_tickets DROP CONSTRAINT IF EXISTS support_tickets_status_check;
ALTER TABLE public.support_tickets ADD CONSTRAINT support_tickets_status_check
  CHECK (status IN ('open', 'in_progress', 'waiting', 'resolved', 'closed'));

-- ==========================================
-- MIGRATION COMPLETE
-- ==========================================

-- Log migration
DO $$
BEGIN
  RAISE NOTICE 'Helmies Bites multi-tenant migration completed successfully!';
  RAISE NOTICE 'New tables: tenants, wizard_sessions, onboarding_tasks, tenant_domains, ai_credits, theme_presets, support_tickets, email_templates, support_messages, payouts';
  RAISE NOTICE 'New functions: current_tenant_id(), tenant_from_subdomain(), set_tenant_context()';
  RAISE NOTICE 'New views: active_tenants, tenant_statistics, wizard_progress';
END $$;
