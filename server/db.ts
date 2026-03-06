import 'dotenv/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import postgres from 'postgres';
import winston from 'winston';

// Logger configuration
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: process.env.NODE_ENV === 'production'
    ? winston.format.json()
    : winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' })
  ]
});

// Extended logger with flexible overloads
const extendedLogger = {
  info: (obj: any, message?: string) => {
    if (message) {
      logger.info(message, obj);
    } else {
      logger.info(obj);
    }
  },
  error: (obj: any, message?: string) => {
    if (message) {
      logger.error(message, obj);
    } else {
      logger.error(obj);
    }
  },
  warn: (obj: any, message?: string) => {
    if (message) {
      logger.warn(message, obj);
    } else {
      logger.warn(obj);
    }
  },
  debug: (obj: any, message?: string) => {
    if (message) {
      logger.debug(message, obj);
    } else {
      logger.debug(obj);
    }
  }
};

// Supabase client for service role operations
const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY!;

if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error('Missing Supabase environment variables');
}

export const supabase: SupabaseClient = createClient(
  supabaseUrl,
  supabaseServiceKey,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  }
);

// PostgreSQL client for direct queries
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error('Missing DATABASE_URL environment variable');
}

export const sql = postgres(databaseUrl, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
  onnotice: (notice: any) => logger.debug('PostgreSQL notice:', notice),
});

// Database query helper functions
export const db = {
  // Tenants
  tenants: {
    create: (data: any) => sql`
      INSERT INTO public.tenants (
        slug, name, name_en, description, description_en,
        status, subscription_tier, stripe_customer_id,
        helmies_fee_percentage, monthly_fee, features, metadata
      ) VALUES (
        ${data.slug}, ${data.name}, ${data.name_en}, ${data.description}, ${data.description_en},
        ${data.status || 'pending'}, ${data.subscription_tier || 'starter'},
        ${data.stripe_customer_id}, ${data.helmies_fee_percentage || 5},
        ${data.monthly_fee || 0}, ${data.features || {}}, ${data.metadata || {}}
      )
      RETURNING *
    `,

    findOne: (conditions: any) => {
      const keys = Object.keys(conditions);
      const whereClause = keys.map((key, i) => `${key} = $${i + 1}`).join(' AND ');
      return sql`SELECT * FROM public.tenants WHERE ${sql.unsafe(whereClause)} LIMIT 1`.values(...(Object.values(conditions) as any[]));
    },

    findAll: (conditions: any = {}) => {
      const keys = Object.keys(conditions);
      if (keys.length === 0) {
        return sql`SELECT * FROM public.tenants ORDER BY created_at DESC`;
      }
      const whereClause = keys.map((key, i) => `${key} = $${i + 1}`).join(' AND ');
      return sql`SELECT * FROM public.tenants WHERE ${sql.unsafe(whereClause)} ORDER BY created_at DESC`.values(...(Object.values(conditions) as any[]));
    },

    update: (id: string, data: any) => {
      const keys = Object.keys(data);
      const setClause = keys.map((key, i) => `${key} = $${i + 2}`).join(', ');
      return sql`UPDATE public.tenants SET ${sql.unsafe(setClause)}, updated_at = NOW() WHERE id = $1 RETURNING *`.values(id, ...(Object.values(data) as any[]));
    },

    delete: (id: string) => sql`DELETE FROM public.tenants WHERE id = ${id} RETURNING *`,
  },

  // Wizard Sessions
  wizardSessions: {
    create: (data: any) => sql`
      INSERT INTO public.wizard_sessions (id, email, step, data, status)
      VALUES (
        gen_random_uuid(), ${data.email}, ${data.step || 'restaurant-info'},
        ${data.data || {}}, ${data.status || 'in_progress'}
      )
      RETURNING *
    `,

    findOne: (id: string) => sql`SELECT * FROM public.wizard_sessions WHERE id = ${id} LIMIT 1`,

    findByEmail: (email: string) => sql`
      SELECT * FROM public.wizard_sessions
      WHERE email = ${email}
      ORDER BY created_at DESC
      LIMIT 1
    `,

    update: (id: string, data: any) => {
      const keys = Object.keys(data);
      const setClause = keys.map((key, i) => `${key} = $${i + 2}`).join(', ');
      return sql`UPDATE public.wizard_sessions SET ${sql.unsafe(setClause)}, updated_at = NOW() WHERE id = $1 RETURNING *`.values(id, ...(Object.values(data) as any[]));
    },

    delete: (id: string) => sql`DELETE FROM public.wizard_sessions WHERE id = ${id} RETURNING *`,
  },

  // Onboarding Tasks
  onboardingTasks: {
    create: (data: any) => sql`
      INSERT INTO public.onboarding_tasks (tenant_id, task_type, status, data, error_message)
      VALUES (
        ${data.tenant_id}, ${data.task_type}, ${data.status || 'pending'},
        ${data.data || {}}, ${data.error_message || null}
      )
      RETURNING *
    `,

    findByTenantId: (tenantId: string) => sql`
      SELECT * FROM public.onboarding_tasks
      WHERE tenant_id = ${tenantId}
      ORDER BY created_at ASC
    `,

    update: (id: string, data: any) => {
      const keys = Object.keys(data);
      const setClause = keys.map((key, i) => `${key} = $${i + 2}`).join(', ');
      return sql`UPDATE public.onboarding_tasks SET ${sql.unsafe(setClause)}, updated_at = NOW() WHERE id = $1 RETURNING *`.values(id, ...(Object.values(data) as any[]));
    },

    updateByTenantAndType: (tenantId: string, taskType: string, data: any) => {
      const keys = Object.keys(data);
      const setClause = keys.map((key, i) => `${key} = $${i + 3}`).join(', ');
      return sql`
        UPDATE public.onboarding_tasks
        SET ${sql.unsafe(setClause)}, updated_at = NOW()
        WHERE tenant_id = $1 AND task_type = $2
        RETURNING *
      `.values(tenantId, taskType, ...(Object.values(data) as any[]));
    },
  },

  // Tenant Domains
  tenantDomains: {
    create: (data: any) => sql`
      INSERT INTO public.tenant_domains (tenant_id, domain_type, domain, is_primary, ssl_status, dns_verified)
      VALUES (
        ${data.tenant_id}, ${data.domain_type}, ${data.domain},
        ${data.is_primary || false}, ${data.ssl_status || 'pending'},
        ${data.dns_verified || false}
      )
      RETURNING *
    `,

    findByTenantId: (tenantId: string) => sql`
      SELECT * FROM public.tenant_domains
      WHERE tenant_id = ${tenantId}
      ORDER BY is_primary DESC, created_at ASC
    `,

    findByDomain: (domain: string) => sql`
      SELECT * FROM public.tenant_domains
      WHERE domain = ${domain}
      LIMIT 1
    `,
  },

  // AI Credits
  aiCredits: {
    create: (data: any) => sql`
      INSERT INTO public.ai_credits (tenant_id, credit_type, amount, cost, description)
      VALUES (
        ${data.tenant_id}, ${data.credit_type}, ${data.amount},
        ${data.cost}, ${data.description || null}
      )
      RETURNING *
    `,

    findByTenantId: (tenantId: string) => sql`
      SELECT * FROM public.ai_credits
      WHERE tenant_id = ${tenantId}
      ORDER BY created_at DESC
    `,

    sumByTenant: (tenantId: string) => sql`
      SELECT
        credit_type,
        COUNT(*) as count,
        SUM(cost) as total_cost
      FROM public.ai_credits
      WHERE tenant_id = ${tenantId}
      GROUP BY credit_type
    `,
  },

  // Support Tickets
  supportTickets: {
    create: (data: any) => sql`
      INSERT INTO public.support_tickets (tenant_id, subject, message, status, priority)
      VALUES (
        ${data.tenant_id}, ${data.subject}, ${data.message},
        ${data.status || 'open'}, ${data.priority || 'normal'}
      )
      RETURNING *
    `,

    findByTenantId: (tenantId: string) => sql`
      SELECT * FROM public.support_tickets
      WHERE tenant_id = ${tenantId}
      ORDER BY priority DESC, created_at DESC
    `,

    update: (id: string, data: any) => {
      const keys = Object.keys(data);
      const setClause = keys.map((key, i) => `${key} = $${i + 2}`).join(', ');
      return sql`UPDATE public.support_tickets SET ${sql.unsafe(setClause)}, updated_at = NOW() WHERE id = $1 RETURNING *`.values(id, ...(Object.values(data) as any[]));
    },
  },

  // Email Templates
  emailTemplates: {
    findByType: (type: string) => sql`
      SELECT * FROM public.email_templates
      WHERE template_type = ${type} AND is_active = true
      LIMIT 1
    `,

    findAll: () => sql`
      SELECT * FROM public.email_templates
      WHERE is_active = true
      ORDER BY template_type ASC
    `,
  },

  // Theme Presets
  themePresets: {
    findAll: () => sql`
      SELECT * FROM public.theme_presets
      WHERE is_active = true
      ORDER BY display_order ASC, name ASC
    `,

    findById: (id: string) => sql`
      SELECT * FROM public.theme_presets
      WHERE id = ${id} AND is_active = true
      LIMIT 1
    `,

    findByCategory: (category: string) => sql`
      SELECT * FROM public.theme_presets
      WHERE category = ${category} AND is_active = true
      ORDER BY display_order ASC
    `,
  },

  // Statistics
  statistics: {
    getPlatformOverview: async () => {
      const result = await sql`
        SELECT
          COUNT(DISTINCT t.id) as active_tenants,
          COALESCE(SUM(t.monthly_fee), 0) as monthly_recurring_revenue,
          COALESCE(SUM(o.subtotal), 0) as total_orders_value,
          COUNT(DISTINCT o.id) as total_orders_count
        FROM public.tenants t
        LEFT JOIN public.orders o ON o.tenant_id = t.id AND o.created_at >= NOW() - INTERVAL '30 days'
        WHERE t.status = 'active'
      `;
      return result[0];
    },

    getTenantStats: async (tenantId: string) => {
      const result = await sql`
        SELECT
          COUNT(DISTINCT o.id) as total_orders,
          COALESCE(SUM(o.total_amount), 0) as total_revenue,
          COUNT(DISTINCT c.id) as total_customers,
          COUNT(DISTINCT mi.id) as menu_items_count
        FROM public.tenants t
        LEFT JOIN public.orders o ON o.tenant_id = t.id
        LEFT JOIN public.customers c ON c.tenant_id = t.id
        LEFT JOIN public.menu_items mi ON mi.tenant_id = t.id
        WHERE t.id = ${tenantId}
        GROUP BY t.id
      `;
      return result[0];
    },
  },
};

export default db;
export { logger, extendedLogger };
