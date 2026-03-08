-- Helmie's Food Web Database Schema
-- This schema creates all necessary tables, sequences, and relationships for the restaurant system

-- Create sequences first (required for auto-incrementing IDs)
CREATE SEQUENCE IF NOT EXISTS public.categories_id_seq;
CREATE SEQUENCE IF NOT EXISTS public.menu_items_id_seq;
CREATE SEQUENCE IF NOT EXISTS public.orders_id_seq;
CREATE SEQUENCE IF NOT EXISTS public.order_items_id_seq;
CREATE SEQUENCE IF NOT EXISTS public.restaurant_settings_id_seq;
CREATE SEQUENCE IF NOT EXISTS public.toppings_id_seq;
CREATE SEQUENCE IF NOT EXISTS public.users_id_seq;

-- Create tables in dependency order

-- 1. Users table (no dependencies)
CREATE TABLE IF NOT EXISTS public.users (
  id integer NOT NULL DEFAULT nextval('users_id_seq'::regclass),
  branch_id integer REFERENCES public.branches(id) ON DELETE SET NULL,
  email text NOT NULL UNIQUE,
  password text NOT NULL,
  role text NOT NULL DEFAULT 'admin'::text,
  is_active boolean DEFAULT true,
  created_at timestamp without time zone DEFAULT now(),
  last_login timestamp without time zone,
  CONSTRAINT users_pkey PRIMARY KEY (id)
);

-- 2. Categories table (no dependencies)
CREATE TABLE IF NOT EXISTS public.categories (
  id integer NOT NULL DEFAULT nextval('categories_id_seq'::regclass),
  name text NOT NULL,
  name_en text NOT NULL,
  name_ru text,
  name_sv text,
  display_order integer DEFAULT 0,
  is_active boolean DEFAULT true,
  CONSTRAINT categories_pkey PRIMARY KEY (id)
);

-- 3. Menu items table (depends on categories)
CREATE TABLE IF NOT EXISTS public.menu_items (
  id integer NOT NULL DEFAULT nextval('menu_items_id_seq'::regclass),
  category_id integer,
  branch_id integer REFERENCES public.branches(id) ON DELETE SET NULL,
  name text NOT NULL,
  name_en text NOT NULL,
  name_ru text,
  name_sv text,
  description text,
  description_en text,
  description_ru text,
  description_sv text,
  price numeric NOT NULL,
  image_url text,
  is_vegetarian boolean DEFAULT false,
  is_vegan boolean DEFAULT false,
  is_gluten_free boolean DEFAULT false,
  display_order integer DEFAULT 0,
  is_available boolean DEFAULT true,
  offer_price numeric,
  offer_percentage integer,
  offer_start_date timestamp without time zone,
  offer_end_date timestamp without time zone,
  has_conditional_pricing boolean DEFAULT false,
  included_toppings_count integer DEFAULT 0,
  created_at timestamp without time zone DEFAULT now(),
  updated_at timestamp without time zone DEFAULT now(),
  CONSTRAINT menu_items_pkey PRIMARY KEY (id),
  CONSTRAINT menu_items_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.categories(id) ON DELETE SET NULL
);

-- 4. Orders table (no dependencies on other main tables)
CREATE TABLE IF NOT EXISTS public.orders (
  id integer NOT NULL DEFAULT nextval('orders_id_seq'::regclass),
  branch_id integer REFERENCES public.branches(id),
  customer_id integer,
  order_number text NOT NULL UNIQUE,
  customer_name text NOT NULL,
  customer_phone text NOT NULL,
  customer_email text,
  delivery_address text,
  order_type text NOT NULL CHECK (order_type IN ('delivery', 'pickup', 'dine-in')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'confirmed', 'preparing', 'ready', 'completed', 'delivered', 'cancelled')),
  subtotal numeric NOT NULL CHECK (subtotal >= 0),
  delivery_fee numeric DEFAULT 0 CHECK (delivery_fee >= 0),
  small_order_fee numeric(10,2) DEFAULT 0,
  total_amount numeric NOT NULL CHECK (total_amount >= 0),
  payment_method text DEFAULT 'cash',
  payment_status text DEFAULT 'pending' CHECK (payment_status IN ('pending', 'processing', 'paid', 'failed', 'canceled', 'refunded', 'partially_refunded')),
  stripe_payment_intent_id text,
  payment_method_details jsonb,
  saved_payment_method_id integer,
  payment_retry_count integer DEFAULT 0,
  last_payment_error jsonb,
  refund_amount numeric(10,2),
  refund_reason text,
  refunded_at timestamp without time zone,
  special_instructions text,
  created_at timestamp without time zone DEFAULT now(),
  updated_at timestamp without time zone DEFAULT now(),
  CONSTRAINT orders_pkey PRIMARY KEY (id)
);

-- 5. Order items table (depends on orders and menu_items)
CREATE TABLE IF NOT EXISTS public.order_items (
  id integer NOT NULL DEFAULT nextval('order_items_id_seq'::regclass),
  order_id integer NOT NULL,
  menu_item_id integer NOT NULL,
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price numeric NOT NULL CHECK (unit_price >= 0),
  total_price numeric NOT NULL CHECK (total_price >= 0),
  special_instructions text,
  CONSTRAINT order_items_pkey PRIMARY KEY (id),
  CONSTRAINT order_items_menu_item_id_fkey FOREIGN KEY (menu_item_id) REFERENCES public.menu_items(id) ON DELETE RESTRICT,
  CONSTRAINT order_items_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE
);

-- 6. Printers table (no dependencies)
-- Note: Only 'network' type is supported now. Direct printing uses device's built-in service.
CREATE TABLE IF NOT EXISTS public.printers (
  id text NOT NULL,
  name text NOT NULL,
  type text NOT NULL CHECK (type IN ('network')),
  printer_type text NOT NULL DEFAULT 'star' CHECK (printer_type IN ('star', 'escpos')),
  address text NOT NULL,
  port integer NOT NULL,
  is_default boolean DEFAULT false,
  is_active boolean DEFAULT true,
  capabilities jsonb DEFAULT '{}',
  metadata jsonb DEFAULT '{}',
  font_settings jsonb DEFAULT '{"restaurantName":{"width":2,"height":2},"header":{"width":2,"height":2},"orderNumber":{"width":2,"height":3},"menuItems":{"width":2,"height":2},"toppings":{"width":1,"height":1},"totals":{"width":2,"height":2},"finalTotal":{"width":3,"height":3},"characterSpacing":0}'::jsonb,
  created_at timestamp without time zone DEFAULT now(),
  updated_at timestamp without time zone DEFAULT now(),
  CONSTRAINT printers_pkey PRIMARY KEY (id)
);

-- 7. Branches table (for multi-location support)
CREATE TABLE IF NOT EXISTS public.branches (
  id serial PRIMARY KEY,
  name text NOT NULL,
  name_en text NOT NULL,
  name_ru text,
  name_sv text,
  address text NOT NULL,
  city text NOT NULL,
  postal_code text NOT NULL,
  latitude decimal(10, 8) NOT NULL,
  longitude decimal(11, 8) NOT NULL,
  phone text NOT NULL,
  email text,
  is_active boolean DEFAULT true,
  display_order integer DEFAULT 0,
  opening_hours jsonb,
  created_at timestamp without time zone DEFAULT now(),
  updated_at timestamp without time zone DEFAULT now()
);

-- 8. Restaurant settings table (with optional printer reference)
CREATE TABLE IF NOT EXISTS public.restaurant_settings (
  id integer NOT NULL DEFAULT nextval('restaurant_settings_id_seq'::regclass),
  is_open boolean DEFAULT true,
  is_busy boolean DEFAULT false,
  opening_hours text NOT NULL,
  pickup_hours text NOT NULL,
  delivery_hours text NOT NULL,
  lunch_buffet_hours text NOT NULL,
  special_message text,
  updated_at timestamp without time zone NOT NULL DEFAULT now(),
  default_printer_id text,
  printer_auto_reconnect boolean DEFAULT true,
  printer_tab_sticky boolean DEFAULT true,
  receipt_format varchar DEFAULT 'text',
  direct_print_enabled boolean DEFAULT true,
  payment_methods jsonb DEFAULT '[
    {"id": "cash", "nameFi": "Käteinen", "nameEn": "Cash", "enabled": true, "icon": "banknote"},
    {"id": "card", "nameFi": "Kortti", "nameEn": "Card", "enabled": true, "icon": "credit-card"}
  ]'::jsonb,
  stripe_enabled boolean DEFAULT false,
  stripe_publishable_key text,
  stripe_secret_key text,
  stripe_webhook_secret text,
  stripe_test_mode boolean DEFAULT true,
  stripe_connect_account_id text,
  stripe_account_email text,
  stripe_account_country text,
  stripe_payment_methods_config jsonb DEFAULT '{}'::jsonb,
  CONSTRAINT restaurant_settings_pkey PRIMARY KEY (id),
  CONSTRAINT restaurant_settings_default_printer_fkey FOREIGN KEY (default_printer_id) REFERENCES public.printers(id) ON DELETE SET NULL
);

-- 8. Session table (for session management)
CREATE TABLE IF NOT EXISTS public.session (
  sid character varying NOT NULL,
  sess json NOT NULL,
  expire timestamp without time zone NOT NULL,
  CONSTRAINT session_pkey PRIMARY KEY (sid)
);

-- 9. Toppings table (no dependencies)
CREATE TABLE IF NOT EXISTS public.toppings (
  id integer NOT NULL DEFAULT nextval('toppings_id_seq'::regclass),
  name text NOT NULL,
  name_en text NOT NULL,
  name_ar text,
  name_ru text,
  name_sv text,
  price numeric NOT NULL DEFAULT 0.00 CHECK (price >= 0),
  is_active boolean DEFAULT true,
  display_order integer DEFAULT 0,
  category text NOT NULL DEFAULT 'pizza',
  type text NOT NULL DEFAULT 'topping',
  is_required boolean DEFAULT false,
  created_at timestamp without time zone DEFAULT now(),
  updated_at timestamp without time zone DEFAULT now(),
  CONSTRAINT toppings_pkey PRIMARY KEY (id)
);

-- 10. Topping groups table
CREATE TABLE IF NOT EXISTS public.topping_groups (
  id serial PRIMARY KEY,
  name text NOT NULL,
  name_en text NOT NULL,
  name_ru text,
  name_sv text,
  is_required boolean DEFAULT false,
  min_selections integer DEFAULT 0,
  max_selections integer DEFAULT 99,
  selection_type text DEFAULT 'checkbox' CHECK (selection_type IN ('checkbox', 'radio')),
  display_order integer DEFAULT 0,
  created_at timestamp without time zone DEFAULT now(),
  updated_at timestamp without time zone DEFAULT now()
);

COMMENT ON COLUMN public.topping_groups.selection_type IS 'Type of selection UI: checkbox for multiple selections, radio for single selection';

-- 11. Topping group items (join table)
CREATE TABLE IF NOT EXISTS public.topping_group_items (
  id serial PRIMARY KEY,
  topping_group_id integer NOT NULL REFERENCES public.topping_groups(id) ON DELETE CASCADE,
  topping_id integer NOT NULL REFERENCES public.toppings(id) ON DELETE CASCADE,
  display_order integer DEFAULT 0,
  created_at timestamp without time zone DEFAULT now()
);

-- 12. Category topping groups (join table)
CREATE TABLE IF NOT EXISTS public.category_topping_groups (
  id serial PRIMARY KEY,
  category_id integer NOT NULL REFERENCES public.categories(id) ON DELETE CASCADE,
  topping_group_id integer NOT NULL REFERENCES public.topping_groups(id) ON DELETE CASCADE,
  created_at timestamp without time zone DEFAULT now(),
  UNIQUE(category_id, topping_group_id)
);

-- 13. Order item toppings (tracks selected toppings for order items)
CREATE TABLE IF NOT EXISTS public.order_item_toppings (
  id serial PRIMARY KEY,
  order_item_id integer NOT NULL REFERENCES public.order_items(id) ON DELETE CASCADE,
  topping_id integer NOT NULL REFERENCES public.toppings(id) ON DELETE RESTRICT,
  quantity integer DEFAULT 1,
  unit_price numeric NOT NULL,
  created_at timestamp without time zone DEFAULT now()
);

-- 14. Promotions table
CREATE TABLE IF NOT EXISTS public.promotions (
  id serial PRIMARY KEY,
  name text NOT NULL,
  name_en text NOT NULL,
  name_ru text,
  name_sv text,
  description text,
  description_en text,
  description_ru text,
  description_sv text,
  discount_type text NOT NULL CHECK (discount_type IN ('percentage', 'fixed')),
  discount_value numeric(10, 2) NOT NULL,
  category_id integer REFERENCES public.categories(id) ON DELETE CASCADE,
  branch_id integer REFERENCES public.branches(id) ON DELETE CASCADE,
  start_date timestamp NOT NULL,
  end_date timestamp NOT NULL,
  is_active boolean DEFAULT true,
  min_order_amount numeric(10, 2) DEFAULT 0,
  max_discount_amount numeric(10, 2),
  created_at timestamp DEFAULT now(),
  updated_at timestamp DEFAULT now()
);

-- 15. Locations table
CREATE TABLE IF NOT EXISTS public.locations (
  id serial PRIMARY KEY,
  name varchar(255) NOT NULL,
  address varchar(500) NOT NULL,
  city varchar(100) NOT NULL,
  postal_code varchar(20),
  icon varchar(100) DEFAULT 'MapPin',
  logo_url varchar(500),
  region varchar(100),
  display_order integer DEFAULT 0,
  is_active boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);

-- 16. Lounas settings table (lunch time configuration)
CREATE TABLE IF NOT EXISTS public.lounas_settings (
  id serial PRIMARY KEY,
  branch_id integer NOT NULL REFERENCES public.branches(id) ON DELETE CASCADE,
  start_time time NOT NULL DEFAULT '10:30:00',
  end_time time NOT NULL DEFAULT '14:00:00',
  serves_sunday boolean DEFAULT false,
  serves_monday boolean DEFAULT true,
  serves_tuesday boolean DEFAULT true,
  serves_wednesday boolean DEFAULT true,
  serves_thursday boolean DEFAULT true,
  serves_friday boolean DEFAULT true,
  serves_saturday boolean DEFAULT false,
  info_text text,
  info_text_en text,
  info_text_ar text,
  info_text_ru text,
  info_text_sv text,
  price_text text,
  price_text_en text,
  price_text_ar text,
  price_text_ru text,
  price_text_sv text,
  is_enabled boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(branch_id)
);

-- 17. Lounas menus table (weekly lunch menu items)
CREATE TABLE IF NOT EXISTS public.lounas_menus (
  id serial PRIMARY KEY,
  branch_id integer NOT NULL REFERENCES public.branches(id) ON DELETE CASCADE,
  week_number integer NOT NULL,
  year integer NOT NULL,
  day_of_week integer NOT NULL CHECK (day_of_week >= 0 AND day_of_week <= 6),
  name text NOT NULL,
  name_en text,
  name_ar text,
  name_ru text,
  name_sv text,
  description text,
  description_en text,
  description_ar text,
  description_ru text,
  description_sv text,
  price text DEFAULT '',
  is_lactose_free boolean DEFAULT false,
  is_gluten_free boolean DEFAULT false,
  is_vegan boolean DEFAULT false,
  is_milk_free boolean DEFAULT false,
  is_hot boolean DEFAULT true,
  image_url text,
  display_order integer DEFAULT 0,
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(branch_id, year, week_number, day_of_week, display_order)
);

-- 18. Customers table (for customer accounts and Stripe integration)
CREATE TABLE IF NOT EXISTS public.customers (
  id serial PRIMARY KEY,
  auth_id uuid UNIQUE,
  email varchar(255) NOT NULL UNIQUE,
  name text,
  phone varchar(50),
  first_name varchar(100),
  last_name varchar(100),
  addresses jsonb DEFAULT '[]'::jsonb,
  default_address_index integer DEFAULT 0,
  marketing_emails boolean DEFAULT false,
  sms_notifications boolean DEFAULT false,
  is_verified boolean DEFAULT false,
  is_active boolean DEFAULT true,
  total_orders integer DEFAULT 0,
  total_spent decimal(10, 2) DEFAULT 0,
  loyalty_points integer DEFAULT 0,
  stripe_customer_id text UNIQUE,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  last_login_at timestamptz
);

-- 19. Printer settings table (user/branch specific printer preferences)
CREATE TABLE IF NOT EXISTS public.printer_settings (
  id serial PRIMARY KEY,
  user_id integer REFERENCES public.users(id) ON DELETE CASCADE,
  branch_id integer REFERENCES public.branches(id) ON DELETE CASCADE,
  printer_mode text NOT NULL DEFAULT 'direct' CHECK (printer_mode IN ('direct', 'network', 'cloudprnt')),
  active_printer_id text,
  active_printer_mac text,
  active_printer_type text CHECK (active_printer_type IN ('star', 'escpos')),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(user_id, branch_id)
);

-- 20. Print jobs table (tracking print job status)
CREATE TABLE IF NOT EXISTS public.print_jobs (
  id serial PRIMARY KEY,
  order_id integer REFERENCES public.orders(id) ON DELETE CASCADE,
  printer_id text REFERENCES public.printers(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'printing', 'completed', 'failed')),
  error_message text,
  created_at timestamptz DEFAULT now(),
  completed_at timestamptz
);

-- 21. Coupons table (promotional discount codes)
CREATE TABLE IF NOT EXISTS public.coupons (
  id serial PRIMARY KEY,
  code text NOT NULL UNIQUE,
  description text,
  discount_type text NOT NULL CHECK (discount_type IN ('percentage', 'fixed')),
  discount_value decimal(10, 2) NOT NULL,
  min_order_amount decimal(10, 2) DEFAULT 0,
  max_uses integer,
  used_count integer DEFAULT 0,
  valid_from timestamptz DEFAULT now(),
  valid_until timestamptz,
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- 22. Saved payment methods table (for returning customers)
CREATE TABLE IF NOT EXISTS public.saved_payment_methods (
  id serial PRIMARY KEY,
  customer_id integer NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  stripe_payment_method_id text NOT NULL UNIQUE,
  type text NOT NULL,
  card_brand text,
  card_last4 text,
  card_exp_month integer,
  card_exp_year integer,
  is_default boolean DEFAULT false,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- 23. Payment attempts table (tracking payment retry logic)
CREATE TABLE IF NOT EXISTS public.payment_attempts (
  id serial PRIMARY KEY,
  order_id text NOT NULL,
  stripe_payment_intent_id text NOT NULL,
  amount decimal(10, 2) NOT NULL,
  currency text DEFAULT 'eur',
  status text NOT NULL CHECK (status IN ('pending', 'processing', 'succeeded', 'failed', 'canceled')),
  error_code text,
  error_message text,
  payment_method_type text,
  attempt_number integer DEFAULT 1,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- 24. Payment analytics table (daily aggregated metrics)
CREATE TABLE IF NOT EXISTS public.payment_analytics (
  id serial PRIMARY KEY,
  date date NOT NULL UNIQUE,
  total_attempts integer DEFAULT 0,
  successful_payments integer DEFAULT 0,
  failed_payments integer DEFAULT 0,
  canceled_payments integer DEFAULT 0,
  total_amount decimal(10, 2) DEFAULT 0,
  refunded_amount decimal(10, 2) DEFAULT 0,
  payment_method_breakdown jsonb DEFAULT '{}'::jsonb,
  average_transaction_amount decimal(10, 2) DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- 25. Payment receipts table (receipt tracking and delivery)
CREATE TABLE IF NOT EXISTS public.payment_receipts (
  id serial PRIMARY KEY,
  order_id text NOT NULL,
  receipt_number text NOT NULL UNIQUE,
  receipt_url text,
  pdf_url text,
  email_sent boolean DEFAULT false,
  email_sent_at timestamptz,
  created_at timestamptz DEFAULT now()
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_categories_display_order ON public.categories(display_order);
CREATE INDEX IF NOT EXISTS idx_categories_is_active ON public.categories(is_active);

CREATE INDEX IF NOT EXISTS idx_menu_items_category_id ON public.menu_items(category_id);
CREATE INDEX IF NOT EXISTS idx_menu_items_branch_id ON public.menu_items(branch_id);
CREATE INDEX IF NOT EXISTS idx_menu_items_is_available ON public.menu_items(is_available);
CREATE INDEX IF NOT EXISTS idx_menu_items_display_order ON public.menu_items(display_order);
CREATE INDEX IF NOT EXISTS idx_menu_items_offer_dates ON public.menu_items(offer_start_date, offer_end_date);
CREATE INDEX IF NOT EXISTS idx_menu_items_conditional_pricing ON public.menu_items(has_conditional_pricing) WHERE has_conditional_pricing = true;

CREATE INDEX IF NOT EXISTS idx_orders_status ON public.orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_order_type ON public.orders(order_type);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON public.orders(created_at);
CREATE INDEX IF NOT EXISTS idx_orders_customer_phone ON public.orders(customer_phone);
CREATE INDEX IF NOT EXISTS idx_orders_branch_id ON public.orders(branch_id);

CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON public.order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_menu_item_id ON public.order_items(menu_item_id);

CREATE INDEX IF NOT EXISTS idx_toppings_category ON public.toppings(category);
CREATE INDEX IF NOT EXISTS idx_toppings_is_active ON public.toppings(is_active);
CREATE INDEX IF NOT EXISTS idx_toppings_display_order ON public.toppings(display_order);

CREATE INDEX IF NOT EXISTS idx_topping_group_items_group_id ON public.topping_group_items(topping_group_id);
CREATE INDEX IF NOT EXISTS idx_topping_group_items_topping_id ON public.topping_group_items(topping_id);

CREATE INDEX IF NOT EXISTS idx_order_item_toppings_order_item_id ON public.order_item_toppings(order_item_id);
CREATE INDEX IF NOT EXISTS idx_order_item_toppings_topping_id ON public.order_item_toppings(topping_id);

CREATE INDEX IF NOT EXISTS idx_printers_is_active ON public.printers(is_active);
CREATE INDEX IF NOT EXISTS idx_printers_is_default ON public.printers(is_default);

CREATE INDEX IF NOT EXISTS idx_branches_is_active ON public.branches(is_active);
CREATE INDEX IF NOT EXISTS idx_branches_display_order ON public.branches(display_order);

CREATE INDEX IF NOT EXISTS idx_promotions_category_id ON public.promotions(category_id);
CREATE INDEX IF NOT EXISTS idx_promotions_branch_id ON public.promotions(branch_id);
CREATE INDEX IF NOT EXISTS idx_promotions_dates ON public.promotions(start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_promotions_active ON public.promotions(is_active);

CREATE INDEX IF NOT EXISTS idx_locations_city ON public.locations(city);
CREATE INDEX IF NOT EXISTS idx_locations_region ON public.locations(region);
CREATE INDEX IF NOT EXISTS idx_locations_active ON public.locations(is_active);
CREATE INDEX IF NOT EXISTS idx_locations_order ON public.locations(display_order);

CREATE INDEX IF NOT EXISTS idx_lounas_menus_branch_week ON public.lounas_menus(branch_id, year, week_number);
CREATE INDEX IF NOT EXISTS idx_lounas_menus_active ON public.lounas_menus(is_active, year, week_number);

CREATE INDEX IF NOT EXISTS idx_customers_auth_id ON public.customers(auth_id);
CREATE INDEX IF NOT EXISTS idx_customers_email ON public.customers(email);
CREATE INDEX IF NOT EXISTS idx_customers_phone ON public.customers(phone);
CREATE INDEX IF NOT EXISTS idx_customers_stripe_id ON public.customers(stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_customers_active ON public.customers(is_active);

CREATE INDEX IF NOT EXISTS idx_print_jobs_order_id ON public.print_jobs(order_id);
CREATE INDEX IF NOT EXISTS idx_print_jobs_status ON public.print_jobs(status);

CREATE INDEX IF NOT EXISTS idx_coupons_code ON public.coupons(code);
CREATE INDEX IF NOT EXISTS idx_coupons_is_active ON public.coupons(is_active);

CREATE INDEX IF NOT EXISTS idx_saved_payment_methods_customer ON public.saved_payment_methods(customer_id);
CREATE INDEX IF NOT EXISTS idx_saved_payment_methods_stripe_id ON public.saved_payment_methods(stripe_payment_method_id);

CREATE INDEX IF NOT EXISTS idx_payment_attempts_order ON public.payment_attempts(order_id);
CREATE INDEX IF NOT EXISTS idx_payment_attempts_intent ON public.payment_attempts(stripe_payment_intent_id);
CREATE INDEX IF NOT EXISTS idx_payment_attempts_status ON public.payment_attempts(status);

CREATE INDEX IF NOT EXISTS idx_payment_analytics_date ON public.payment_analytics(date);

CREATE INDEX IF NOT EXISTS idx_payment_receipts_order ON public.payment_receipts(order_id);
CREATE INDEX IF NOT EXISTS idx_payment_receipts_number ON public.payment_receipts(receipt_number);

CREATE INDEX IF NOT EXISTS idx_orders_customer ON public.orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_stripe_intent ON public.orders(stripe_payment_intent_id);

CREATE INDEX IF NOT EXISTS idx_users_branch_id ON public.users(branch_id);

CREATE INDEX IF NOT EXISTS idx_session_expire ON public.session(expire);

-- Set sequence ownership to ensure proper cleanup
ALTER SEQUENCE public.categories_id_seq OWNED BY public.categories.id;
ALTER SEQUENCE public.menu_items_id_seq OWNED BY public.menu_items.id;
ALTER SEQUENCE public.orders_id_seq OWNED BY public.orders.id;
ALTER SEQUENCE public.order_items_id_seq OWNED BY public.order_items.id;
ALTER SEQUENCE public.restaurant_settings_id_seq OWNED BY public.restaurant_settings.id;
ALTER SEQUENCE public.toppings_id_seq OWNED BY public.toppings.id;
ALTER SEQUENCE public.users_id_seq OWNED BY public.users.id;

-- Create a trigger function to automatically update the updated_at column
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Create triggers for tables that have updated_at columns
CREATE TRIGGER update_orders_updated_at 
    BEFORE UPDATE ON public.orders 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_restaurant_settings_updated_at 
    BEFORE UPDATE ON public.restaurant_settings 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_printers_updated_at 
    BEFORE UPDATE ON public.printers 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_menu_items_updated_at 
    BEFORE UPDATE ON public.menu_items 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_toppings_updated_at 
    BEFORE UPDATE ON public.toppings 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_topping_groups_updated_at 
    BEFORE UPDATE ON public.topping_groups 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_promotions_updated_at 
    BEFORE UPDATE ON public.promotions 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_branches_updated_at 
    BEFORE UPDATE ON public.branches 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_locations_updated_at 
    BEFORE UPDATE ON public.locations 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_lounas_settings_updated_at 
    BEFORE UPDATE ON public.lounas_settings 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_lounas_menus_updated_at 
    BEFORE UPDATE ON public.lounas_menus 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_customers_updated_at 
    BEFORE UPDATE ON public.customers 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_printer_settings_updated_at 
    BEFORE UPDATE ON public.printer_settings 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_coupons_updated_at 
    BEFORE UPDATE ON public.coupons 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_saved_payment_methods_updated_at 
    BEFORE UPDATE ON public.saved_payment_methods 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_payment_attempts_updated_at 
    BEFORE UPDATE ON public.payment_attempts 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_payment_analytics_updated_at 
    BEFORE UPDATE ON public.payment_analytics 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Ensure only one default printer exists
CREATE OR REPLACE FUNCTION ensure_single_default_printer()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.is_default = true THEN
        -- Set all other printers to not default
        UPDATE public.printers SET is_default = false WHERE id != NEW.id;
    END IF;
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER ensure_single_default_printer_trigger
    BEFORE INSERT OR UPDATE ON public.printers
    FOR EACH ROW EXECUTE FUNCTION ensure_single_default_printer();

-- Comments for documentation
COMMENT ON TABLE public.categories IS 'Food categories (e.g., Pizza, Pasta, Drinks)';
COMMENT ON TABLE public.menu_items IS 'Individual menu items with pricing and availability';
COMMENT ON COLUMN public.menu_items.branch_id IS 'If NULL, the menu item is available at all branches. If set, the item is only available at the specified branch.';
COMMENT ON COLUMN public.menu_items.has_conditional_pricing IS 'Enables conditional pricing based on topping count';
COMMENT ON COLUMN public.menu_items.included_toppings_count IS 'Number of toppings included in base price for conditional pricing';
COMMENT ON TABLE public.orders IS 'Customer orders with delivery/pickup information';
COMMENT ON COLUMN public.orders.branch_id IS 'Reference to the branch that will process this order - used for delivery distance calculation';
COMMENT ON COLUMN public.orders.small_order_fee IS 'Fee added when order total is below minimum (€15)';
COMMENT ON COLUMN public.orders.payment_status IS 'Payment status: pending (awaiting payment), paid (payment confirmed), failed (payment failed), refunded (payment refunded)';
COMMENT ON COLUMN public.orders.stripe_payment_intent_id IS 'Stripe Payment Intent ID for online payments';
COMMENT ON TABLE public.order_items IS 'Individual items within an order';
COMMENT ON TABLE public.toppings IS 'Available toppings/add-ons for menu items';
COMMENT ON TABLE public.topping_groups IS 'Groups of toppings for customizable menu items';
COMMENT ON TABLE public.topping_group_items IS 'Join table linking toppings to topping groups';
COMMENT ON TABLE public.category_topping_groups IS 'Join table linking categories to topping groups';
COMMENT ON TABLE public.order_item_toppings IS 'Tracks which toppings were selected for each order item';
COMMENT ON TABLE public.printers IS 'Thermal printers for order receipts';
COMMENT ON TABLE public.branches IS 'Restaurant branch locations for multi-location support';
COMMENT ON TABLE public.restaurant_settings IS 'Restaurant operational settings and hours';
COMMENT ON COLUMN public.restaurant_settings.is_busy IS 'Indicates if restaurant is temporarily too busy to accept orders';
COMMENT ON COLUMN public.restaurant_settings.receipt_format IS 'Receipt printing format: text (simple) or pdf (modern with styling)';
COMMENT ON COLUMN public.restaurant_settings.direct_print_enabled IS 'Enable or disable DirectPrint (Android Print Framework) - when disabled, uses network printer fallback';
COMMENT ON COLUMN public.restaurant_settings.payment_methods IS 'Available payment methods (JSONB array with id, nameFi, nameEn, enabled, icon, requiresStripe)';
COMMENT ON COLUMN public.restaurant_settings.stripe_enabled IS 'Whether Stripe payment integration is enabled';
COMMENT ON COLUMN public.restaurant_settings.stripe_publishable_key IS 'Stripe publishable key (pk_test_... or pk_live_...) for client-side integration';
COMMENT ON COLUMN public.restaurant_settings.stripe_secret_key IS 'Stripe secret key (should be encrypted in production)';
COMMENT ON COLUMN public.restaurant_settings.stripe_webhook_secret IS 'Stripe webhook secret for validating webhook events';
COMMENT ON COLUMN public.restaurant_settings.stripe_test_mode IS 'Whether Stripe is in test mode';
COMMENT ON COLUMN public.restaurant_settings.stripe_connect_account_id IS 'Stripe Connect account ID';
COMMENT ON COLUMN public.restaurant_settings.stripe_account_email IS 'Email associated with Stripe account';
COMMENT ON COLUMN public.restaurant_settings.stripe_account_country IS 'Country code for Stripe account';
COMMENT ON COLUMN public.restaurant_settings.stripe_payment_methods_config IS 'Configuration for which Stripe payment methods are enabled (card, applePay, googlePay, etc.)';
COMMENT ON TABLE public.users IS 'Admin users for restaurant management';
COMMENT ON COLUMN public.users.branch_id IS 'Associates a user with a specific branch. Orders from that branch will be routed to this user.';
COMMENT ON TABLE public.session IS 'User session storage';
COMMENT ON TABLE public.promotions IS 'Promotional discounts that can be applied to categories at specific branches';
COMMENT ON COLUMN public.promotions.category_id IS 'If NULL, promotion applies to all categories';
COMMENT ON COLUMN public.promotions.branch_id IS 'If NULL, promotion applies to all branches';
COMMENT ON COLUMN public.promotions.discount_type IS 'Type of discount: percentage (e.g., 20%) or fixed amount (e.g., 5.00€)';
COMMENT ON COLUMN public.promotions.min_order_amount IS 'Minimum order amount required for promotion to apply';
COMMENT ON COLUMN public.promotions.max_discount_amount IS 'Maximum discount amount cap (useful for percentage discounts)';
COMMENT ON TABLE public.locations IS 'Store/pickup locations for the restaurant chain';
COMMENT ON TABLE public.lounas_settings IS 'Stores lunch serving time settings per branch';
COMMENT ON TABLE public.lounas_menus IS 'Weekly lunch menu items for restaurant branches';
COMMENT ON COLUMN public.lounas_menus.week_number IS 'ISO week number (1-53)';
COMMENT ON COLUMN public.lounas_menus.day_of_week IS '0=Sunday, 1=Monday, 2=Tuesday, 3=Wednesday, 4=Thursday, 5=Friday, 6=Saturday';
COMMENT ON COLUMN public.lounas_menus.is_lactose_free IS 'Item is lactose-free';
COMMENT ON COLUMN public.lounas_menus.is_gluten_free IS 'Item is gluten-free';
COMMENT ON COLUMN public.lounas_menus.is_vegan IS 'Item is vegan';
COMMENT ON COLUMN public.lounas_menus.is_milk_free IS 'Item is dairy-free';
COMMENT ON COLUMN public.lounas_menus.is_hot IS 'Item is served hot';
COMMENT ON TABLE public.customers IS 'Customer accounts with Stripe integration for saved payment methods';
COMMENT ON TABLE public.printer_settings IS 'User-specific printer preferences per branch';
COMMENT ON TABLE public.print_jobs IS 'Print job queue for tracking receipt printing';
COMMENT ON TABLE public.coupons IS 'Promotional discount codes for orders';
COMMENT ON TABLE public.saved_payment_methods IS 'Saved Stripe payment methods for returning customers';
COMMENT ON TABLE public.payment_attempts IS 'Payment attempt history for retry logic and debugging';
COMMENT ON TABLE public.payment_analytics IS 'Daily aggregated payment metrics and statistics';
COMMENT ON TABLE public.payment_receipts IS 'Payment receipt tracking and email delivery status';

-- Insert default restaurant settings
INSERT INTO public.restaurant_settings (
    is_open, 
    opening_hours, 
    pickup_hours, 
    delivery_hours, 
    lunch_buffet_hours,
    special_message
) VALUES (
    true,
    '11:00-23:00',
    '11:00-23:00', 
    '11:00-22:30',
    '11:30-15:00',
    'Welcome to Helmie''s Food!'
) ON CONFLICT DO NOTHING;

-- Enable Row Level Security (RLS) on all tables
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.menu_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.printers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.restaurant_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.toppings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.topping_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.topping_group_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.category_topping_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_item_toppings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.branches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.promotions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lounas_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lounas_menus ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.session ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.printer_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.print_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.coupons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.saved_payment_methods ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_analytics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_receipts ENABLE ROW LEVEL SECURITY;

-- Helper function to check if user is authenticated admin
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.users 
    WHERE email = current_setting('request.jwt.claims', true)::json->>'email'
    AND role = 'admin' 
    AND is_active = true
  );
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Helper function to get current user ID
CREATE OR REPLACE FUNCTION public.current_user_id()
RETURNS integer AS $$
BEGIN
  RETURN (
    SELECT id FROM public.users 
    WHERE email = current_setting('request.jwt.claims', true)::json->>'email'
    AND is_active = true
  );
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ==========================================
-- RLS POLICIES FOR USERS TABLE
-- ==========================================

-- Users can only be managed by admins
CREATE POLICY "Admin can manage all users" ON public.users
  FOR ALL USING (public.is_admin());

-- Allow users to view their own profile
CREATE POLICY "Users can view own profile" ON public.users
  FOR SELECT USING (current_setting('request.jwt.claims', true)::json->>'email' = email);

-- ==========================================
-- RLS POLICIES FOR CATEGORIES TABLE
-- ==========================================

-- Anyone can view active categories (for menu display)
CREATE POLICY "Anyone can view active categories" ON public.categories
  FOR SELECT USING (is_active = true);

-- Only admins can manage categories
CREATE POLICY "Admin can manage categories" ON public.categories
  FOR ALL USING (public.is_admin());

-- ==========================================
-- RLS POLICIES FOR MENU_ITEMS TABLE
-- ==========================================

-- Anyone can view available menu items
CREATE POLICY "Anyone can view available menu items" ON public.menu_items
  FOR SELECT USING (is_available = true);

-- Only admins can manage menu items
CREATE POLICY "Admin can manage menu items" ON public.menu_items
  FOR ALL USING (public.is_admin());

-- ==========================================
-- RLS POLICIES FOR TOPPINGS TABLE
-- ==========================================

-- Anyone can view active toppings
CREATE POLICY "Anyone can view active toppings" ON public.toppings
  FOR SELECT USING (is_active = true);

-- Only admins can manage toppings
CREATE POLICY "Admin can manage toppings" ON public.toppings
  FOR ALL USING (public.is_admin());

-- ==========================================
-- RLS POLICIES FOR ORDERS TABLE
-- ==========================================

-- Customers can create their own orders
CREATE POLICY "Anyone can create orders" ON public.orders
  FOR INSERT WITH CHECK (true);

-- Customers can view their own orders (by phone number)
CREATE POLICY "Customers can view own orders" ON public.orders
  FOR SELECT USING (
    customer_phone = current_setting('request.header.customer-phone', true) OR
    customer_email = current_setting('request.header.customer-email', true)
  );

-- Admins can view and manage all orders
CREATE POLICY "Admin can manage all orders" ON public.orders
  FOR ALL USING (public.is_admin());

-- Allow updates for order status changes (with restrictions)
CREATE POLICY "Limited order updates" ON public.orders
  FOR UPDATE USING (
    public.is_admin() OR 
    (status IN ('pending', 'confirmed') AND customer_phone = current_setting('request.header.customer-phone', true))
  );

-- ==========================================
-- RLS POLICIES FOR ORDER_ITEMS TABLE
-- ==========================================

-- Anyone can insert order items (when creating an order)
CREATE POLICY "Anyone can create order items" ON public.order_items
  FOR INSERT WITH CHECK (true);

-- Customers can view their own order items
CREATE POLICY "Customers can view own order items" ON public.order_items
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.orders 
      WHERE id = order_id 
      AND (
        customer_phone = current_setting('request.header.customer-phone', true) OR
        customer_email = current_setting('request.header.customer-email', true)
      )
    )
  );

-- Admins can manage all order items
CREATE POLICY "Admin can manage all order items" ON public.order_items
  FOR ALL USING (public.is_admin());

-- ==========================================
-- RLS POLICIES FOR RESTAURANT_SETTINGS TABLE
-- ==========================================

-- Anyone can view restaurant settings (for business hours, status)
CREATE POLICY "Anyone can view restaurant settings" ON public.restaurant_settings
  FOR SELECT USING (true);

-- Only admins can modify restaurant settings
CREATE POLICY "Admin can manage restaurant settings" ON public.restaurant_settings
  FOR ALL USING (public.is_admin());

-- ==========================================
-- RLS POLICIES FOR PRINTERS TABLE
-- ==========================================

-- Only admins can manage printers
CREATE POLICY "Admin can manage printers" ON public.printers
  FOR ALL USING (public.is_admin());

-- ==========================================
-- RLS POLICIES FOR SESSION TABLE
-- ==========================================

-- Users can only access their own sessions
CREATE POLICY "Users can manage own sessions" ON public.session
  FOR ALL USING (
    sid = current_setting('request.header.session-id', true) OR
    public.is_admin()
  );

-- ==========================================
-- RLS POLICIES FOR TOPPING GROUPS AND ITEMS
-- ==========================================

-- Anyone can view active topping groups
CREATE POLICY "Anyone can view topping groups" ON public.topping_groups
  FOR SELECT USING (true);

-- Only admins can manage topping groups
CREATE POLICY "Admin can manage topping groups" ON public.topping_groups
  FOR ALL USING (public.is_admin());

-- Anyone can view topping group items
CREATE POLICY "Anyone can view topping group items" ON public.topping_group_items
  FOR SELECT USING (true);

-- Only admins can manage topping group items
CREATE POLICY "Admin can manage topping group items" ON public.topping_group_items
  FOR ALL USING (public.is_admin());

-- Anyone can view category topping groups
CREATE POLICY "Anyone can view category topping groups" ON public.category_topping_groups
  FOR SELECT USING (true);

-- Only admins can manage category topping groups
CREATE POLICY "Admin can manage category topping groups" ON public.category_topping_groups
  FOR ALL USING (public.is_admin());

-- Anyone can insert order item toppings (when creating orders)
CREATE POLICY "Anyone can create order item toppings" ON public.order_item_toppings
  FOR INSERT WITH CHECK (true);

-- Customers can view their own order item toppings
CREATE POLICY "Customers can view own order item toppings" ON public.order_item_toppings
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.order_items oi
      INNER JOIN public.orders o ON oi.order_id = o.id
      WHERE oi.id = order_item_id
      AND (
        o.customer_phone = current_setting('request.header.customer-phone', true) OR
        o.customer_email = current_setting('request.header.customer-email', true)
      )
    )
  );

-- Admins can manage all order item toppings
CREATE POLICY "Admin can manage all order item toppings" ON public.order_item_toppings
  FOR ALL USING (public.is_admin());

-- ==========================================
-- RLS POLICIES FOR BRANCHES TABLE
-- ==========================================

-- Anyone can view active branches
CREATE POLICY "Anyone can view active branches" ON public.branches
  FOR SELECT USING (is_active = true);

-- Only admins can manage branches
CREATE POLICY "Admin can manage branches" ON public.branches
  FOR ALL USING (public.is_admin());

-- ==========================================
-- RLS POLICIES FOR PROMOTIONS TABLE
-- ==========================================

-- Anyone can view active promotions
CREATE POLICY "Anyone can view active promotions" ON public.promotions
  FOR SELECT USING (is_active = true);

-- Only admins can manage promotions
CREATE POLICY "Admin can manage promotions" ON public.promotions
  FOR ALL USING (public.is_admin());

-- ==========================================
-- RLS POLICIES FOR LOCATIONS TABLE
-- ==========================================

-- Anyone can view active locations
CREATE POLICY "Anyone can view active locations" ON public.locations
  FOR SELECT USING (is_active = true);

-- Only admins can manage locations
CREATE POLICY "Admin can manage locations" ON public.locations
  FOR ALL USING (public.is_admin());

-- ==========================================
-- RLS POLICIES FOR LOUNAS SETTINGS TABLE
-- ==========================================

-- Anyone can view lounas settings
CREATE POLICY "Anyone can view lounas settings" ON public.lounas_settings
  FOR SELECT USING (true);

-- Only admins can manage lounas settings
CREATE POLICY "Admin can manage lounas settings" ON public.lounas_settings
  FOR ALL USING (public.is_admin());

-- ==========================================
-- RLS POLICIES FOR LOUNAS MENUS TABLE
-- ==========================================

-- Anyone can view active lounas menus
CREATE POLICY "Anyone can view active lounas menus" ON public.lounas_menus
  FOR SELECT USING (is_active = true);

-- Only admins can manage lounas menus
CREATE POLICY "Admin can manage lounas menus" ON public.lounas_menus
  FOR ALL USING (public.is_admin());

-- RLS Policies for customers table
CREATE POLICY "Users can view their own customer profile" ON public.customers
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert their own customer profile" ON public.customers
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update their own customer profile" ON public.customers
  FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Admins can manage all customers" ON public.customers
  FOR ALL USING (public.is_admin());

-- RLS Policies for printer_settings table
CREATE POLICY "Admins can manage printer settings" ON public.printer_settings
  FOR ALL USING (public.is_admin());

-- RLS Policies for print_jobs table
CREATE POLICY "Admins can manage print jobs" ON public.print_jobs
  FOR ALL USING (public.is_admin());

-- RLS Policies for coupons table
CREATE POLICY "Anyone can view active coupons" ON public.coupons
  FOR SELECT USING (is_active = true);
CREATE POLICY "Admins can manage coupons" ON public.coupons
  FOR ALL USING (public.is_admin());

-- RLS Policies for saved_payment_methods table
CREATE POLICY "Users can view their own payment methods" ON public.saved_payment_methods
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert their own payment methods" ON public.saved_payment_methods
  FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update their own payment methods" ON public.saved_payment_methods
  FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete their own payment methods" ON public.saved_payment_methods
  FOR DELETE USING (auth.uid() = user_id);
CREATE POLICY "Admins can manage all payment methods" ON public.saved_payment_methods
  FOR ALL USING (public.is_admin());

-- RLS Policies for payment_attempts table
CREATE POLICY "Users can view their own payment attempts" ON public.payment_attempts
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.orders o 
      WHERE o.id::text = payment_attempts.order_id 
      AND o.user_id = auth.uid()
    )
  );
CREATE POLICY "Admins can manage all payment attempts" ON public.payment_attempts
  FOR ALL USING (public.is_admin());

-- RLS Policies for payment_analytics table
CREATE POLICY "Admins can manage payment analytics" ON public.payment_analytics
  FOR ALL USING (public.is_admin());

-- RLS Policies for payment_receipts table
CREATE POLICY "Users can view their own receipts" ON public.payment_receipts
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.orders o 
      WHERE o.id::text = payment_receipts.order_id 
      AND o.user_id = auth.uid()
    )
  );
CREATE POLICY "Admins can manage all receipts" ON public.payment_receipts
  FOR ALL USING (public.is_admin());

-- ==========================================
-- GRANT PERMISSIONS
-- ==========================================

-- Grant usage on sequences to authenticated users
GRANT USAGE ON SEQUENCE public.categories_id_seq TO authenticated;
GRANT USAGE ON SEQUENCE public.menu_items_id_seq TO authenticated;
GRANT USAGE ON SEQUENCE public.orders_id_seq TO authenticated;
GRANT USAGE ON SEQUENCE public.order_items_id_seq TO authenticated;
GRANT USAGE ON SEQUENCE public.restaurant_settings_id_seq TO authenticated;
GRANT USAGE ON SEQUENCE public.toppings_id_seq TO authenticated;
GRANT USAGE ON SEQUENCE public.users_id_seq TO authenticated;

-- Grant table permissions to authenticated users
GRANT SELECT ON public.categories TO authenticated;
GRANT SELECT ON public.menu_items TO authenticated;
GRANT SELECT ON public.toppings TO authenticated;
GRANT SELECT ON public.topping_groups TO authenticated;
GRANT SELECT ON public.topping_group_items TO authenticated;
GRANT SELECT ON public.category_topping_groups TO authenticated;
GRANT SELECT ON public.branches TO authenticated;
GRANT SELECT ON public.promotions TO authenticated;
GRANT SELECT ON public.locations TO authenticated;
GRANT SELECT ON public.lounas_settings TO authenticated;
GRANT SELECT ON public.lounas_menus TO authenticated;
GRANT SELECT ON public.restaurant_settings TO authenticated;

-- Grant insert/select permissions for orders (customers need to create orders)
GRANT INSERT, SELECT, UPDATE ON public.orders TO authenticated;
GRANT INSERT, SELECT ON public.order_items TO authenticated;
GRANT INSERT, SELECT ON public.order_item_toppings TO authenticated;

-- Grant all permissions to service_role (for admin operations)
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;

-- Grant permissions for session management
GRANT ALL ON public.session TO authenticated;
GRANT ALL ON public.users TO authenticated;

-- Grant permissions for new tables
GRANT SELECT, INSERT, UPDATE ON public.customers TO authenticated;
GRANT SELECT ON public.coupons TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.saved_payment_methods TO authenticated;
GRANT SELECT ON public.payment_attempts TO authenticated;
GRANT SELECT ON public.payment_receipts TO authenticated;

/*
  # Create restaurant configuration table

  1. New Tables
    - `restaurant_config`
      - `id` (uuid, primary key)
      - `name` (text, restaurant name in Finnish)
      - `name_en` (text, restaurant name in English)
      - `tagline` (text, tagline in Finnish)
      - `tagline_en` (text, tagline in English)
      - `description` (text, description in Finnish)
      - `description_en` (text, description in English)
      - `phone` (text, phone number)
      - `email` (text, email address)
      - `address` (jsonb, address object)
      - `social_media` (jsonb, social media links)
      - `hours` (jsonb, business hours configuration)
      - `services` (jsonb, available services)
      - `delivery_config` (jsonb, delivery zones and settings)
      - `theme` (jsonb, theme colors and branding)
      - `logo` (jsonb, logo configuration)
      - `about` (jsonb, about section content)
      - `hero` (jsonb, hero section configuration)
      - `is_active` (boolean, whether this config is active)
      - `created_at` (timestamp)
      - `updated_at` (timestamp)

  2. Security
    - Enable RLS on `restaurant_config` table
    - Add policy for public read access to active config
    - Add policy for authenticated admin write access

  3. Data
    - Insert default Ravintola Babylon configuration
*/

CREATE TABLE IF NOT EXISTS restaurant_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  name_en text NOT NULL,
  tagline text NOT NULL,
  tagline_en text NOT NULL,
  description text NOT NULL,
  description_en text NOT NULL,
  phone text NOT NULL,
  email text NOT NULL,
  address jsonb NOT NULL DEFAULT '{}',
  social_media jsonb DEFAULT '{}',
  hours jsonb NOT NULL DEFAULT '{}',
  services jsonb NOT NULL DEFAULT '{}',
  delivery_config jsonb NOT NULL DEFAULT '{}',
  theme jsonb NOT NULL DEFAULT '{}',
  page_layout_variants jsonb NOT NULL DEFAULT '{"home":"variant1","menu":"variant1","about":"variant1","header":"variant1","footer":"variant1","cart":"variant1","checkout":"variant1"}',
  logo jsonb NOT NULL DEFAULT '{}',
  about jsonb NOT NULL DEFAULT '{}',
  hero jsonb NOT NULL DEFAULT '{}',
  is_active boolean DEFAULT false,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE restaurant_config ENABLE ROW LEVEL SECURITY;

-- Public can read active restaurant config
CREATE POLICY "Anyone can read active restaurant config"
  ON restaurant_config
  FOR SELECT
  USING (is_active = true);

-- Only authenticated admins can manage restaurant config
CREATE POLICY "Admin can manage restaurant config"
  ON restaurant_config
  FOR ALL
  USING (public.is_admin());

-- Ensure only one active config at a time
CREATE OR REPLACE FUNCTION ensure_single_active_config()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.is_active = true THEN
    -- Set all other configs to inactive
    UPDATE restaurant_config SET is_active = false WHERE id != NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ensure_single_active_config_trigger
  BEFORE INSERT OR UPDATE ON restaurant_config
  FOR EACH ROW EXECUTE FUNCTION ensure_single_active_config();

-- Auto-update updated_at timestamp
CREATE TRIGGER update_restaurant_config_updated_at
  BEFORE UPDATE ON restaurant_config
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Insert default Ravintola Babylon configuration
INSERT INTO restaurant_config (
  name,
  name_en,
  tagline,
  tagline_en,
  description,
  description_en,
  phone,
  email,
  address,
  social_media,
  hours,
  services,
  delivery_config,
  theme,
  logo,
  about,
  hero,
  is_active
) VALUES (
  'Ravintola Babylon',
  'Ravintola Babylon',
  'Laadukkaita aterioita Lahden sydämessä',
  'Quality meals in the heart of Lahti',
  'Ravintola Babylonssa tarjoamme laadukkaita aterioita ja kutsumme sinut maistamaan herkullisia ruokiamme.',
  'At Ravintola Babylon we offer quality meals and invite you to taste our delicious food.',
  '+35835899089',
  'info@ravintolababylon.fi',
  '{
    "street": "Vapaudenkatu 28",
    "postalCode": "15140",
    "city": "Lahti",
    "country": "Finland"
  }',
  '{
    "facebook": "https://www.facebook.com/profile.php?id=61577964717473"
  }',
  '{
    "general": {
      "monday": {"open": "10:30", "close": "10:29", "closed": false},
      "tuesday": {"open": "10:30", "close": "10:29", "closed": false},
      "wednesday": {"open": "10:30", "close": "10:29", "closed": false},
      "thursday": {"open": "10:30", "close": "10:29", "closed": false},
      "friday": {"open": "10:30", "close": "22:00", "closed": false},
      "saturday": {"open": "10:30", "close": "05:30", "closed": false},
      "sunday": {"open": "10:30", "close": "10:29", "closed": false}
    },
    "pickup": {
      "monday": {"open": "10:30", "close": "10:29", "closed": false},
      "tuesday": {"open": "10:30", "close": "10:29", "closed": false},
      "wednesday": {"open": "10:30", "close": "10:29", "closed": false},
      "thursday": {"open": "10:30", "close": "10:29", "closed": false},
      "friday": {"open": "10:30", "close": "22:00", "closed": false},
      "saturday": {"open": "10:30", "close": "05:30", "closed": false},
      "sunday": {"open": "10:30", "close": "10:29", "closed": false}
    },
    "delivery": {
      "monday": {"open": "10:30", "close": "10:29", "closed": false},
      "tuesday": {"open": "10:30", "close": "10:29", "closed": false},
      "wednesday": {"open": "10:30", "close": "10:29", "closed": false},
      "thursday": {"open": "10:30", "close": "10:29", "closed": false},
      "friday": {"open": "10:30", "close": "22:00", "closed": false},
      "saturday": {"open": "10:30", "close": "05:30", "closed": false},
      "sunday": {"open": "10:30", "close": "10:29", "closed": false}
    }
  }',
  '{
    "hasLunchBuffet": false,
    "hasDelivery": true,
    "hasPickup": true,
    "hasDineIn": true,
    "lunchBuffetHours": null
  }',
  '{
    "zones": [
      {"maxDistance": 4, "fee": 0.00},
      {"maxDistance": 5, "fee": 4.00},
      {"maxDistance": 8, "fee": 7.00},
      {"maxDistance": 10, "fee": 10.00}
    ],
    "location": {
      "lat": 60.9832,
      "lng": 25.6608
    }
  }',
  '{
    "primary": "#8B4513",
    "secondary": "#FF8C00",
    "accent": "#F5E6D3",
    "success": "#16a34a",
    "warning": "#ea580c",
    "error": "#dc2626",
    "background": "#ffffff",
    "foreground": "#1f2937",
    "dark": {
      "background": "hsl(30, 10%, 8%)",
      "foreground": "hsl(0, 0%, 98%)",
      "card": "hsl(30, 8%, 12%)",
      "cardForeground": "hsl(0, 0%, 98%)",
      "popover": "hsl(30, 10%, 8%)",
      "popoverForeground": "hsl(0, 0%, 98%)",
      "primary": "#8B4513",
      "primaryForeground": "hsl(0, 0%, 98%)",
      "secondary": "hsl(30, 5%, 18%)",
      "secondaryForeground": "hsl(0, 0%, 98%)",
      "muted": "hsl(30, 5%, 15%)",
      "mutedForeground": "hsl(240, 5%, 64.9%)",
      "accent": "hsl(30, 5%, 18%)",
      "accentForeground": "hsl(0, 0%, 98%)",
      "destructive": "hsl(0, 62.8%, 30.6%)",
      "destructiveForeground": "hsl(0, 0%, 98%)",
      "border": "hsl(30, 5%, 18%)",
      "input": "hsl(30, 5%, 18%)",
      "ring": "hsl(240, 4.9%, 83.9%)"
    }
  }',
  '{
    "icon": "Pizza",
    "imageUrl": "https://foozu3.fi/pizzaadmin/web_admin_common/foodzone//logo/8minqduoo4o4c8kwgw.png",
    "showText": true,
    "backgroundColor": "#8B4513"
  }',
  '{
    "story": "Ravintola Babylonssa tarjoamme laadukkaita aterioita ja kutsumme sinut maistamaan herkullisia ruokiamme.",
    "storyEn": "At Ravintola Babylon we offer quality meals and invite you to taste our delicious food.",
    "mission": "Tarjoamme Lahdessa parhaita pizzoja, kebabeja ja muita herkullisia ruokia ystävällisessä palvelussa.",
    "missionEn": "We offer the best pizzas, kebabs and other delicious food in Lahti with friendly service.",
    "specialties": [
      {
        "title": "Premium Pizzat",
        "titleEn": "Premium Pizzas",
        "description": "Huippulaadukkaita pizzoja tuoreista aineksista",
        "descriptionEn": "Premium quality pizzas made from fresh ingredients",
        "icon": "Pizza"
      },
      {
        "title": "Kebabit",
        "titleEn": "Kebabs",
        "description": "Meheviä ja maukkaita kebabeja eri vaihtoehdoilla",
        "descriptionEn": "Juicy and tasty kebabs with different options",
        "icon": "UtensilsCrossed"
      },
      {
        "title": "Legendaariset Rullat",
        "titleEn": "Legendary Wraps",
        "description": "Kuuluisiksi tulleet rullat täynnä makua",
        "descriptionEn": "Famous wraps full of flavor",
        "icon": "ChefHat"
      },
      {
        "title": "Gyros Annokset",
        "titleEn": "Gyros Dishes",
        "description": "Perinteisiä kreikkalaisia gyros-annoksia",
        "descriptionEn": "Traditional Greek gyros dishes",
        "icon": "Heart"
      }
    ],
    "experience": "Laadukasta ruokaa Lahdessa",
    "experienceEn": "Quality food in Lahti"
  }',
  '{
    "backgroundImage": "https://images.unsplash.com/photo-1513104890138-7c749659a591?ixlib=rb-4.0.3&auto=format&fit=crop&w=1920&q=80",
    "videoUrl": "https://videos.pexels.com/video-files/3752507/3752507-hd_1920_1080_24fps.mp4",
    "features": [
      {"title": "Premium pizzat", "titleEn": "Premium pizzas", "color": "#FF8C00"},
      {"title": "Nopea toimitus", "titleEn": "Fast delivery", "color": "#8B4513"},
      {"title": "Laadukkaita aterioita", "titleEn": "Quality meals", "color": "#F5E6D3"}
    ]
  }',
  true
) ON CONFLICT DO NOTHING;

-- Create index for faster queries
CREATE INDEX IF NOT EXISTS idx_restaurant_config_active ON restaurant_config(is_active) WHERE is_active = true;

-- Grant permissions
GRANT SELECT ON restaurant_config TO authenticated;
GRANT ALL ON restaurant_config TO service_role;

/*
  # Add light theme structure to restaurant_config

  1. Update existing theme JSON to include light mode structure
  2. Ensure all existing configurations have both light and dark theme objects
  3. Maintain backward compatibility with legacy theme fields

  This migration adds the missing light theme structure that matches
  the dark theme structure already present in the database.
*/

-- Update the existing restaurant config to add light theme structure
UPDATE restaurant_config 
SET theme = jsonb_set(
  theme,
  '{light}',
  '{
    "background": "hsl(0, 0%, 100%)",
    "foreground": "hsl(222.2, 84%, 4.9%)",
    "card": "hsl(0, 0%, 100%)",
    "cardForeground": "hsl(222.2, 84%, 4.9%)",
    "popover": "hsl(0, 0%, 100%)",
    "popoverForeground": "hsl(222.2, 84%, 4.9%)",
    "primary": "#8B4513",
    "primaryForeground": "hsl(0, 0%, 98%)",
    "secondary": "hsl(210, 40%, 96%)",
    "secondaryForeground": "hsl(222.2, 84%, 4.9%)",
    "muted": "hsl(210, 40%, 96%)",
    "mutedForeground": "hsl(215.4, 16.3%, 46.9%)",
    "accent": "#FF8C00",
    "accentForeground": "hsl(0, 0%, 98%)",
    "destructive": "hsl(0, 84.2%, 60.2%)",
    "destructiveForeground": "hsl(0, 0%, 98%)",
    "border": "hsl(214.3, 31.8%, 91.4%)",
    "input": "hsl(214.3, 31.8%, 91.4%)",
    "ring": "#8B4513"
  }'::jsonb
)
WHERE theme IS NOT NULL;

-- Add a comment to document the theme structure
COMMENT ON COLUMN restaurant_config.theme IS 'Theme configuration with light and dark mode support. Contains legacy fields (primary, secondary, etc.) and new light/dark objects with complete CSS custom property definitions for Tailwind CSS theming.';

-- Create a function to validate theme structure (optional, for future use)
CREATE OR REPLACE FUNCTION validate_theme_structure(theme_json jsonb)
RETURNS boolean AS $$
BEGIN
  -- Check if theme has required legacy fields
  IF NOT (
    theme_json ? 'primary' AND
    theme_json ? 'secondary' AND
    theme_json ? 'accent' AND
    theme_json ? 'background' AND
    theme_json ? 'foreground'
  ) THEN
    RETURN false;
  END IF;
  
  -- Check if theme has light and dark objects
  IF NOT (
    theme_json ? 'light' AND
    theme_json ? 'dark'
  ) THEN
    RETURN false;
  END IF;
  
  -- Check if light theme has required fields
  IF NOT (
    theme_json->'light' ? 'background' AND
    theme_json->'light' ? 'foreground' AND
    theme_json->'light' ? 'card' AND
    theme_json->'light' ? 'primary' AND
    theme_json->'light' ? 'border'
  ) THEN
    RETURN false;
  END IF;
  
  -- Check if dark theme has required fields
  IF NOT (
    theme_json->'dark' ? 'background' AND
    theme_json->'dark' ? 'foreground' AND
    theme_json->'dark' ? 'card' AND
    theme_json->'dark' ? 'primary' AND
    theme_json->'dark' ? 'border'
  ) THEN
    RETURN false;
  END IF;
  
  RETURN true;
END;
$$ LANGUAGE plpgsql;

-- Add a check constraint to ensure theme structure is valid (optional)
-- ALTER TABLE restaurant_config 
-- ADD CONSTRAINT valid_theme_structure 
-- CHECK (validate_theme_structure(theme));

-- Update the updated_at timestamp for affected rows
UPDATE restaurant_config 
SET updated_at = now() 
WHERE theme IS NOT NULL;

-- Manual Migration Instructions
-- 
-- Run this SQL in your Supabase SQL Editor to add light theme structure
-- to existing restaurant configurations.

-- Step 1: Check current theme structure
SELECT id, name, theme FROM restaurant_config WHERE is_active = true;

-- Step 2: Add light theme structure to existing config
UPDATE restaurant_config 
SET theme = jsonb_set(
  theme,
  '{light}',
  '{
    "background": "hsl(0, 0%, 100%)",
    "foreground": "hsl(222.2, 84%, 4.9%)",
    "card": "hsl(0, 0%, 100%)",
    "cardForeground": "hsl(222.2, 84%, 4.9%)",
    "popover": "hsl(0, 0%, 100%)",
    "popoverForeground": "hsl(222.2, 84%, 4.9%)",
    "primary": "#8B4513",
    "primaryForeground": "hsl(0, 0%, 98%)",
    "secondary": "hsl(210, 40%, 96%)",
    "secondaryForeground": "hsl(222.2, 84%, 4.9%)",
    "muted": "hsl(210, 40%, 96%)",
    "mutedForeground": "hsl(215.4, 16.3%, 46.9%)",
    "accent": "#FF8C00",
    "accentForeground": "hsl(0, 0%, 98%)",
    "destructive": "hsl(0, 84.2%, 60.2%)",
    "destructiveForeground": "hsl(0, 0%, 98%)",
    "border": "hsl(214.3, 31.8%, 91.4%)",
    "input": "hsl(214.3, 31.8%, 91.4%)",
    "ring": "#8B4513"
  }'::jsonb,
  updated_at = now()
)
WHERE theme IS NOT NULL;

-- Step 3: Verify the update
SELECT id, name, 
       theme->'light' as light_theme,
       theme->'dark' as dark_theme
FROM restaurant_config 
WHERE is_active = true;

-- Optional: Add validation function
CREATE OR REPLACE FUNCTION validate_theme_structure(theme_json jsonb)
RETURNS boolean AS $$
BEGIN
  -- Check if theme has required legacy fields and light/dark objects
  RETURN (
    theme_json ? 'primary' AND
    theme_json ? 'light' AND
    theme_json ? 'dark' AND
    theme_json->'light' ? 'background' AND
    theme_json->'dark' ? 'background'
  );
END;
$$ LANGUAGE plpgsql;

-- Test the validation function
SELECT id, name, validate_theme_structure(theme) as is_valid_theme
FROM restaurant_config;
-- Add printers table for storing printer configurations
CREATE TABLE IF NOT EXISTS printers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT NOT NULL,
  port INTEGER NOT NULL,
  printer_type TEXT NOT NULL,
  is_active BOOLEAN DEFAULT true,
  font_settings JSONB DEFAULT '{"restaurantName":{"width":2,"height":2},"header":{"width":2,"height":2},"orderNumber":{"width":2,"height":3},"menuItems":{"width":2,"height":2},"toppings":{"width":1,"height":1},"totals":{"width":2,"height":2},"finalTotal":{"width":3,"height":3},"characterSpacing":0}'::jsonb,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Add index for faster lookups
CREATE INDEX IF NOT EXISTS idx_printers_is_active ON printers(is_active);


-- Add font_settings column to existing printers table
ALTER TABLE printers 
ADD COLUMN IF NOT EXISTS font_settings JSONB DEFAULT '{
  "restaurantName": {"width": 2, "height": 2},
  "header": {"width": 2, "height": 2},
  "orderNumber": {"width": 2, "height": 3},
  "menuItems": {"width": 2, "height": 2},
  "toppings": {"width": 1, "height": 1},
  "totals": {"width": 2, "height": 2},
  "finalTotal": {"width": 3, "height": 3},
  "characterSpacing": 0
}'::jsonb;

-- Add monthly report settings columns to restaurant_settings table (legacy, kept for backwards compatibility)
ALTER TABLE restaurant_settings
ADD COLUMN IF NOT EXISTS monthly_report_email TEXT,
ADD COLUMN IF NOT EXISTS monthly_report_enabled BOOLEAN DEFAULT FALSE;

-- Add monthly report settings columns to branches table (per-branch reports)
ALTER TABLE branches
ADD COLUMN IF NOT EXISTS monthly_report_email TEXT,
ADD COLUMN IF NOT EXISTS monthly_report_enabled BOOLEAN DEFAULT FALSE;

-- AI Assistant Configuration Table
-- Run this in Supabase SQL Editor

-- Create the ai_assistant_config table
CREATE TABLE IF NOT EXISTS ai_assistant_config (
  id SERIAL PRIMARY KEY,
  api_provider VARCHAR(50) NOT NULL DEFAULT 'openrouter',
  api_key TEXT NOT NULL,
  model VARCHAR(100) NOT NULL DEFAULT 'z-ai/glm-4.5-air:free',
  api_base_url VARCHAR(255) NOT NULL DEFAULT 'https://openrouter.ai/api/v1/chat/completions',
  max_tokens INTEGER DEFAULT 2000,
  temperature DECIMAL(2,1) DEFAULT 0.7,
  is_enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Insert default configuration (you'll need to update the API key)
INSERT INTO ai_assistant_config (api_provider, api_key, model, api_base_url, max_tokens, temperature, is_enabled)
VALUES (
  'openrouter',
  'YOUR_API_KEY_HERE',
  'z-ai/glm-4.5-air:free',
  'https://openrouter.ai/api/v1/chat/completions',
  2000,
  0.7,
  true
)
ON CONFLICT DO NOTHING;

-- Create updated_at trigger
CREATE OR REPLACE FUNCTION update_ai_assistant_config_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ai_assistant_config_updated_at ON ai_assistant_config;
CREATE TRIGGER ai_assistant_config_updated_at
  BEFORE UPDATE ON ai_assistant_config
  FOR EACH ROW
  EXECUTE FUNCTION update_ai_assistant_config_updated_at();

-- Add RLS policies (optional - adjust based on your needs)
ALTER TABLE ai_assistant_config ENABLE ROW LEVEL SECURITY;

-- Allow authenticated users to read config
CREATE POLICY "Allow authenticated read" ON ai_assistant_config
  FOR SELECT TO authenticated USING (true);

-- Allow authenticated users to update config
CREATE POLICY "Allow authenticated update" ON ai_assistant_config
  FOR UPDATE TO authenticated USING (true);

-- Allow service role full access
CREATE POLICY "Allow service role full access" ON ai_assistant_config
  FOR ALL TO service_role USING (true);
