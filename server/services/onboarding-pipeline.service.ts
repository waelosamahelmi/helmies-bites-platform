import { logger, sql } from '../db.js';
import { db } from '../db.js';
import { GitHubService } from './github.service.js';
import { VercelService } from './vercel.service.js';
import { HostingerApiService } from './hostinger-api.service.js';
import { EmailService } from './email.service.js';

/**
 * Onboarding Pipeline Service
 * Orchestrates the complete restaurant onboarding automation
 */
export class OnboardingPipelineService {
  private github: GitHubService;
  private vercel: VercelService;
  private hostinger: HostingerApiService;
  private email: EmailService;

  constructor() {
    this.github = new GitHubService();
    this.vercel = new VercelService();
    this.hostinger = new HostingerApiService();
    this.email = new EmailService();
  }

  /**
   * Complete wizard and trigger full onboarding automation
   */
  async completeWizard(sessionId: string) {
    try {
      logger.info({ sessionId }, 'Starting onboarding pipeline');

      // Get wizard session
      const sessionResult = await db.wizardSessions.findOne(sessionId);
      const session = Array.isArray(sessionResult) ? sessionResult[0] : sessionResult;
      if (!session) {
        throw new Error('Wizard session not found');
      }

      const data = session.data || {};

      // Step 1: Create tenant
      const tenantResult = await this.createTenant(session, data);
      const tenant = Array.isArray(tenantResult) ? tenantResult[0] : tenantResult;

      // Update wizard session with tenant ID
      await sql`UPDATE public.wizard_sessions SET tenant_id = ${tenant.id} WHERE id = ${sessionId}`;

      // Step 2: Save domain configuration
      await this.saveDomainConfig(tenant, data);

      // Step 3: Save Stripe configuration
      await this.saveStripeConfig(tenant, data);

      // Run automation steps in parallel (non-blocking)
      const runAutomation = process.env.ENABLE_FULL_AUTOMATION === 'true';
      
      if (runAutomation) {
        // Run automations in background
        this.runAutomationPipeline(tenant, data, session).catch(err => {
          logger.error({ tenantId: tenant.id, error: err.message }, 'Automation pipeline failed');
        });
      } else {
        // Just activate tenant immediately
        await sql`UPDATE public.tenants SET status = 'active' WHERE id = ${tenant.id}`;
        logger.info({ tenantId: tenant.id }, 'Tenant activated (automation disabled)');
      }

      logger.info({
        sessionId,
        tenantId: tenant.id,
        slug: tenant.slug,
        automationEnabled: runAutomation,
      }, 'Onboarding pipeline completed');

      return tenant;
    } catch (error) {
      logger.error({
        error: error instanceof Error ? error.message : 'Unknown error',
        sessionId,
      }, 'Error in onboarding pipeline');

      throw error;
    }
  }

  /**
   * Run automation pipeline (GitHub, Vercel, Domain, Email)
   */
  private async runAutomationPipeline(tenant: any, data: any, session: any) {
    const tenantId = tenant.id;
    
    // Helper to update task status
    const updateTask = async (taskType: string, status: string, taskData?: any, errorMessage?: string) => {
      try {
        if (status === 'in_progress') {
          // Create task if starting
          await sql`
            INSERT INTO public.onboarding_tasks (tenant_id, task_type, status, data)
            VALUES (${tenantId}, ${taskType}, ${status}, ${JSON.stringify(taskData || {})}::jsonb)
            ON CONFLICT (tenant_id, task_type) DO UPDATE SET
              status = ${status},
              data = ${JSON.stringify(taskData || {})}::jsonb,
              updated_at = NOW()
          `;
        } else {
          await sql`
            UPDATE public.onboarding_tasks 
            SET status = ${status}, 
                data = COALESCE(data, '{}'::jsonb) || ${JSON.stringify(taskData || {})}::jsonb,
                error_message = ${errorMessage || null},
                updated_at = NOW()
            WHERE tenant_id = ${tenantId} AND task_type = ${taskType}
          `;
        }
      } catch (e) {
        logger.warn({ tenantId, taskType, status, error: e }, 'Failed to update task');
      }
    };

    try {
      logger.info({ tenantId }, 'Starting automation pipeline');

      // Initialize all tasks as pending
      const allTasks = ['github_repo', 'email_account', 'vercel_deploy', 'domain_setup', 'welcome_email'];
      for (const taskType of allTasks) {
        await sql`
          INSERT INTO public.onboarding_tasks (tenant_id, task_type, status)
          VALUES (${tenantId}, ${taskType}, 'pending')
          ON CONFLICT (tenant_id, task_type) DO NOTHING
        `;
      }

      // Step 1: Create GitHub repository
      await updateTask('github_repo', 'in_progress');
      try {
        await this.createGitHubRepo(tenant, data);
        await updateTask('github_repo', 'completed', { message: 'Repository created' });
      } catch (error) {
        await updateTask('github_repo', 'failed', null, error instanceof Error ? error.message : 'Unknown error');
        throw error;
      }

      // Step 2: Create email account
      await updateTask('email_account', 'in_progress');
      try {
        await this.createEmailAccount(tenant, data);
        await updateTask('email_account', 'completed', { message: 'Email account created' });
      } catch (error) {
        await updateTask('email_account', 'failed', null, error instanceof Error ? error.message : 'Unknown error');
        // Email failure is non-fatal, continue
        logger.warn({ tenantId, error }, 'Email creation failed, continuing...');
      }

      // Step 3: Deploy to Vercel
      await updateTask('vercel_deploy', 'in_progress');
      try {
        await this.deployToVercel(tenant, data);
        await updateTask('vercel_deploy', 'completed', { message: 'Deployment triggered' });
      } catch (error) {
        await updateTask('vercel_deploy', 'failed', null, error instanceof Error ? error.message : 'Unknown error');
        throw error;
      }

      // Step 4: Configure domain
      await updateTask('domain_setup', 'in_progress');
      try {
        await this.configureDomain(tenant, data);
        await updateTask('domain_setup', 'completed', { message: 'Domain configured' });
      } catch (error) {
        await updateTask('domain_setup', 'failed', null, error instanceof Error ? error.message : 'Unknown error');
        // Domain failure is non-fatal
        logger.warn({ tenantId, error }, 'Domain configuration failed, continuing...');
      }

      // Step 5: Activate tenant
      await sql`UPDATE public.tenants SET status = 'active' WHERE id = ${tenantId}`;

      // Step 6: Send welcome email
      await updateTask('welcome_email', 'in_progress');
      try {
        await this.sendWelcomeEmail(tenant);
        await updateTask('welcome_email', 'completed', { message: 'Welcome email sent' });
      } catch (error) {
        await updateTask('welcome_email', 'failed', null, error instanceof Error ? error.message : 'Unknown error');
        // Non-fatal
      }

      logger.info({ tenantId }, 'Automation pipeline completed successfully');
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ tenantId, error: errorMsg }, 'Automation pipeline failed');

      // Mark tenant with error
      await sql`
        UPDATE public.tenants 
        SET status = 'pending', 
            metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{automation_error}', ${JSON.stringify(errorMsg)}::jsonb)
        WHERE id = ${tenantId}
      `;
    }
  }

  /**
   * Save domain configuration to tenant_domains table
   */
  private async saveDomainConfig(tenant: any, data: any) {
    try {
      const domain = data.domain || {};
      const slug = domain.slug || tenant.slug;

      // Always create subdomain entry
      await sql`
        INSERT INTO public.tenant_domains (tenant_id, domain_type, domain, is_primary, ssl_status)
        VALUES (${tenant.id}, 'subdomain', ${slug + '.helmiesbites.com'}, true, 'pending')
        ON CONFLICT (tenant_id, domain) DO UPDATE SET
          is_primary = true,
          updated_at = NOW()
      `;

      // If custom domain provided, add it too
      if (domain.custom_domain && domain.custom_domain.trim()) {
        await sql`
          INSERT INTO public.tenant_domains (tenant_id, domain_type, domain, is_primary, ssl_status)
          VALUES (${tenant.id}, 'custom', ${domain.custom_domain.trim()}, false, 'pending')
          ON CONFLICT (tenant_id, domain) DO NOTHING
        `;
      }

      logger.info({ tenantId: tenant.id, subdomain: slug + '.helmiesbites.com' }, 'Domain config saved');
    } catch (error) {
      logger.warn({ tenantId: tenant.id, error: error instanceof Error ? error.message : 'Unknown error' }, 'Failed to save domain config');
    }
  }

  /**
   * Save Stripe configuration
   */
  private async saveStripeConfig(tenant: any, data: any) {
    try {
      const stripe = data.stripe || {};

      if (stripe.publishable_key || stripe.secret_key) {
        // Store in tenant metadata (encrypted in production)
        await sql`
          UPDATE public.tenants
          SET metadata = jsonb_set(
            jsonb_set(
              COALESCE(metadata, '{}'::jsonb),
              '{stripe_publishable_key}',
              ${JSON.stringify(stripe.publishable_key || '')}::jsonb
            ),
            '{stripe_test_mode}',
            ${JSON.stringify(stripe.test_mode ?? true)}::jsonb
          )
          WHERE id = ${tenant.id}
        `;

        // Update restaurant_settings with stripe enabled
        await sql`
          UPDATE public.restaurant_settings
          SET stripe_enabled = true,
              stripe_test_mode = ${stripe.test_mode ?? true}
          WHERE tenant_id = ${tenant.id}
        `;

        logger.info({ tenantId: tenant.id, testMode: stripe.test_mode }, 'Stripe config saved');
      }
    } catch (error) {
      logger.warn({ tenantId: tenant.id, error: error instanceof Error ? error.message : 'Unknown error' }, 'Failed to save stripe config');
    }
  }

  /**
   * Step 1: Create tenant
   */
  private async createTenant(session: any, data: any) {
    try {
      logger.info({
        sessionId: session.id,
        email: session.email,
      }, 'Creating tenant');

      // Generate slug from restaurant name and ensure uniqueness
      const baseSlug = this.generateSlug(data.restaurantInfo?.name || session.email.split('@')[0]);
      const slug = await this.ensureUniqueSlug(baseSlug);

      // Calculate monthly fee based on features
      const monthlyFee = this.calculateMonthlyFee(data.features || {});

      // Create tenant (replace undefined with null for postgres.js)
      const tenant = await db.tenants.create({
        slug,
        name: data.restaurantInfo?.name || 'New Restaurant',
        name_en: data.restaurantInfo?.name_en || data.restaurantInfo?.nameEn || null,
        description: data.restaurantInfo?.description || null,
        description_en: data.restaurantInfo?.description_en || data.restaurantInfo?.descriptionEn || null,
        status: 'pending',
        subscription_tier: 'starter',
        helmies_fee_percentage: 5.0,
        monthly_fee: monthlyFee,
        features: {
          cashOnDelivery: data.features?.cashOnDelivery || false,
          aiAssistant: data.features?.aiAssistant || false,
          delivery: data.features?.delivery || true,
          pickup: data.features?.pickup || true,
          lunch: data.features?.lunch || false,
          multiBranch: data.features?.multiBranch || false,
        },
        metadata: {
          contact_email: session.email || '',
          created_via_wizard: true,
        },
      });

      // Initialize tenant with default data (non-blocking)
      try {
        await this.initializeTenantData(tenant.id, data, slug);
      } catch (initError) {
        logger.warn({
          tenantId: tenant.id,
          error: initError instanceof Error ? initError.message : 'Unknown error',
        }, 'Failed to initialize tenant data, continuing anyway');
      }

      logger.info({
        tenantId: tenant.id,
        slug,
      }, 'Tenant created successfully');

      return tenant;
    } catch (error) {
      logger.error({
        error: error instanceof Error ? error.message : 'Unknown error',
      }, 'Error creating tenant');

      throw error;
    }
  }

  /**
   * Initialize tenant with default data
   */
  private async initializeTenantData(tenantId: string, data: any, slug: string) {
    try {
      logger.info({ tenantId, dataKeys: Object.keys(data) }, 'Initializing tenant data');

      // Extract address from restaurantInfo (wizard format) or branchInfo
      const address = data.restaurantInfo?.address || data.branchInfo || {};
      const phone = data.restaurantInfo?.phone || address.phone || '+358 40 123 4567';
      const email = data.restaurantInfo?.email || 'info@' + slug + '.fi';

      // 1. Create default branch
      await sql`
        INSERT INTO public.branches (tenant_id, name, name_en, address, city, postal_code, phone, email, is_default, is_active, latitude, longitude)
        VALUES (
          ${tenantId}, 
          ${data.restaurantInfo?.name || 'Main Branch'},
          ${data.restaurantInfo?.name_en || data.restaurantInfo?.name || 'Main Branch'},
          ${address.street || address.address || 'Address'},
          ${address.city || 'City'},
          ${address.postal_code || address.postalCode || '00100'},
          ${phone},
          ${email},
          true,
          true,
          0.0,
          0.0
        )
        ON CONFLICT DO NOTHING
      `;

      // 2. Create categories and menu items from wizard data
      const menuItems = data.menuItems || [];
      
      if (menuItems.length > 0) {
        // Extract unique categories from menu items
        const categoryMap = new Map<string, number>();
        let categoryOrder = 1;
        
        for (const item of menuItems) {
          const catName = item.category || 'Muut';
          if (!categoryMap.has(catName)) {
            // Insert category
            const catResult = await sql`
              INSERT INTO public.categories (tenant_id, name, name_en, display_order, is_active)
              VALUES (${tenantId}, ${catName}, ${item.category_en || catName}, ${categoryOrder}, true)
              ON CONFLICT DO NOTHING
              RETURNING id
            `;
            if (catResult.length > 0) {
              categoryMap.set(catName, catResult[0].id);
            }
            categoryOrder++;
          }
        }

        // Insert menu items
        let itemOrder = 1;
        for (const item of menuItems) {
          const catName = item.category || 'Muut';
          const categoryId = categoryMap.get(catName);
          
          await sql`
            INSERT INTO public.menu_items (
              tenant_id, category_id, name, name_en, description, description_en, 
              price, image_url, display_order, is_available
            )
            VALUES (
              ${tenantId},
              ${categoryId || null},
              ${item.name || 'Unnamed Item'},
              ${item.name_en || item.name || 'Unnamed Item'},
              ${item.description || null},
              ${item.description_en || item.description || null},
              ${item.price || 0},
              ${item.imageUrl || null},
              ${itemOrder},
              true
            )
            ON CONFLICT DO NOTHING
          `;
          itemOrder++;
        }
        
        logger.info({ tenantId, categoryCount: categoryMap.size, itemCount: menuItems.length }, 'Menu items imported');
      } else {
        // Create default categories based on cuisine type
        const cuisineType = data.restaurantInfo?.cuisine || 'General';
        const defaultCategories = this.getDefaultCategories(cuisineType);

        for (const category of defaultCategories) {
          await sql`
            INSERT INTO public.categories (tenant_id, name, name_en, name_sv, description, description_en, display_order, is_active)
            VALUES (
              ${tenantId},
              ${category.name},
              ${category.nameEn || category.name},
              ${category.nameSv || category.nameEn || category.name},
              ${category.description || ''},
              ${category.descriptionEn || category.description || ''},
              ${category.order || 0},
              true
            )
            ON CONFLICT DO NOTHING
          `;
        }
      }

      // 3. Legacy menu import (if coming from old format)
      if (data.menuUpload?.parsedMenu) {
        await this.importParsedMenu(tenantId, data.menuUpload.parsedMenu);
      }

      // 4. Create restaurant configuration with theme
      // Handle both wizard format (flat colors) and old format (nested)
      const themeColors = data.theme || {};
      const theme = {
        name: 'custom',
        colors: {
          primary: themeColors.primary_color || themeColors.primary || '#FF8C00',
          secondary: themeColors.secondary_color || themeColors.secondary || '#8B4513',
          accent: themeColors.accent_color || themeColors.accent || '#F5E6D3',
          background: themeColors.background_color || themeColors.background || '#ffffff',
          text: themeColors.text_color || themeColors.foreground || '#1f2937',
        }
      };

      // Get logo URL from multiple possible locations
      const logoUrl = data.logoUrl || data.theme?.logoUrl || themeColors.logoUrl || null;
      const logoSvg = data.logoSvg || data.theme?.logoSvg || themeColors.logoSvg || null;

      // Build full restaurant config JSON
      const restaurantConfig = {
        name: data.restaurantInfo?.name || 'New Restaurant',
        name_en: data.restaurantInfo?.name_en || data.restaurantInfo?.name || 'New Restaurant',
        tagline: data.restaurantInfo?.description?.slice(0, 100) || '',
        tagline_en: data.restaurantInfo?.description_en?.slice(0, 100) || '',
        description: data.restaurantInfo?.description || '',
        description_en: data.restaurantInfo?.description_en || '',
        phone: phone,
        email: email,
        address: JSON.stringify(address),
        theme: JSON.stringify({
          primary: theme.colors.primary,
          secondary: theme.colors.secondary,
          accent: theme.colors.accent,
          background: theme.colors.background,
          foreground: theme.colors.text,
        }),
        logo: JSON.stringify({ 
          imageUrl: logoUrl,
          svgData: logoSvg,
        }),
        services: JSON.stringify({
          hasDelivery: data.features?.delivery ?? true,
          hasPickup: data.features?.pickup ?? true,
          hasDineIn: false,
          hasLunchBuffet: data.features?.lunch ?? false,
        }),
        is_active: true,
      };

      logger.info({ tenantId, logoUrl: !!logoUrl, logoSvg: !!logoSvg }, 'Logo data');

      await sql`
        INSERT INTO public.restaurant_config (
          tenant_id, name, name_en, tagline, tagline_en, description, description_en,
          phone, email, address, theme, logo, services, is_active
        )
        VALUES (
          ${tenantId},
          ${restaurantConfig.name},
          ${restaurantConfig.name_en},
          ${restaurantConfig.tagline},
          ${restaurantConfig.tagline_en},
          ${restaurantConfig.description},
          ${restaurantConfig.description_en},
          ${restaurantConfig.phone},
          ${restaurantConfig.email},
          ${restaurantConfig.address}::jsonb,
          ${restaurantConfig.theme}::jsonb,
          ${restaurantConfig.logo}::jsonb,
          ${restaurantConfig.services}::jsonb,
          ${restaurantConfig.is_active}
        )
        ON CONFLICT (tenant_id) DO UPDATE SET
          name = EXCLUDED.name,
          theme = EXCLUDED.theme,
          services = EXCLUDED.services,
          updated_at = NOW()
      `;

      // 5. Create restaurant_settings with operating hours
      const operatingHours = data.operatingHours || {};
      const defaultHours = '10:00-22:00';

      await sql`
        INSERT INTO public.restaurant_settings (
          tenant_id, is_open, is_busy, 
          opening_hours, pickup_hours, delivery_hours, lunch_buffet_hours,
          special_message, stripe_enabled, stripe_test_mode
        )
        VALUES (
          ${tenantId},
          true,
          false,
          ${operatingHours.opening || defaultHours},
          ${operatingHours.pickup || operatingHours.opening || defaultHours},
          ${operatingHours.delivery || operatingHours.opening || '10:00-21:30'},
          ${operatingHours.lunch || '11:00-14:00'},
          ${'Tervetuloa ' + (data.restaurantInfo?.name || 'ravintolaamme') + '!'},
          ${data.stripe?.publishable_key ? true : false},
          ${data.stripe?.test_mode ?? true}
        )
        ON CONFLICT (tenant_id) DO UPDATE SET
          opening_hours = EXCLUDED.opening_hours,
          pickup_hours = EXCLUDED.pickup_hours,
          delivery_hours = EXCLUDED.delivery_hours,
          lunch_buffet_hours = EXCLUDED.lunch_buffet_hours,
          stripe_enabled = EXCLUDED.stripe_enabled,
          stripe_test_mode = EXCLUDED.stripe_test_mode,
          updated_at = NOW()
      `;

      logger.info({ tenantId, hours: operatingHours }, 'Restaurant settings created');

      // 6. Create admin user for the tenant
      const adminPassword = this.generateRandomPassword();
      const hashedPassword = await this.hashPassword(adminPassword);
      
      await sql`
        INSERT INTO public.users (tenant_id, email, password, role, is_active)
        VALUES (
          ${tenantId},
          ${email},
          ${hashedPassword},
          'admin',
          true
        )
        ON CONFLICT (email) DO NOTHING
      `;

      // Store admin credentials in tenant metadata for welcome email
      await sql`
        UPDATE public.tenants 
        SET metadata = jsonb_set(
          COALESCE(metadata, '{}'::jsonb),
          '{admin_password}',
          ${JSON.stringify(adminPassword)}::jsonb
        )
        WHERE id = ${tenantId}
      `;

      // 7. Create default delivery areas (if table exists)
      try {
        await sql`
          INSERT INTO public.delivery_areas (tenant_id, name, postal_codes, min_order_amount, delivery_fee, is_active)
          VALUES (
            ${tenantId},
            'Default Area',
            ARRAY['00100', '00101', '00102', '00103'],
            15.00,
            5.00,
            true
          )
          ON CONFLICT DO NOTHING
        `;
      } catch (e) {
        // delivery_areas table might not exist in all schemas
        logger.warn({ tenantId }, 'Could not create delivery areas (table may not exist)');
      }

      logger.info({ tenantId, email, adminPasswordGenerated: true }, 'Tenant data initialized successfully');
    } catch (error) {
      logger.error({
        error: error instanceof Error ? error.message : 'Unknown error',
        tenantId,
      }, 'Error initializing tenant data');

      // Don't throw - tenant creation should succeed even if data init fails
    }
  }

  /**
   * Get default categories based on cuisine type
   */
  private getDefaultCategories(cuisineType: string): Array<{
    name: string;
    nameEn: string;
    nameSv: string;
    description?: string;
    descriptionEn?: string;
    order: number;
  }> {
    const categoryMap: Record<string, any[]> = {
      'Italian': [
        { name: 'Pizzat', nameEn: 'Pizzas', nameSv: 'Pizzor', description: 'Käsinpellat pitaleivät', descriptionEn: 'Handmade stone oven pizzas', order: 1 },
        { name: 'Pastat', nameEn: 'Pasta', nameSv: 'Pasta', description: 'Italialaiset pastaruoat', descriptionEn: 'Italian pasta dishes', order: 2 },
        { name: 'Jälkiruoat', nameEn: 'Desserts', nameSv: 'Efterrätter', description: 'Italialaiset herkut', descriptionEn: 'Italian desserts', order: 3 },
      ],
      'Asian': [
        { name: 'Keittoruoat', nameEn: 'Wok Dishes', nameSv: 'Wokrätter', description: 'Aasialaiset wok-annokset', descriptionEn: 'Asian wok dishes', order: 1 },
        { name: 'Sushi', nameEn: 'Sushi', nameSv: 'Sushi', description: 'Tuoreet sushiruoat', descriptionEn: 'Fresh sushi dishes', order: 2 },
        { name: 'Noodle annokset', nameEn: 'Noodle Dishes', nameSv: 'Nudelrätter', description: 'Aasialaiset nuudeliruoat', descriptionEn: 'Asian noodle dishes', order: 3 },
      ],
      'Burger': [
        { name: 'Hampurilaiset', nameEn: 'Burgers', nameSv: 'Hamburgare', description: 'Kotiburgereita ja gourmet-burgereita', descriptionEn: 'Beef and gourmet burgers', order: 1 },
        { name: 'Ranskalaiset', nameEn: 'Fries', nameSv: 'Pommes frites', description: 'Rapeutuja ja lisukkeita', descriptionEn: 'Fries and sides', order: 2 },
        { name: 'Juomat', nameEn: 'Drinks', nameSv: 'Drycker', description: 'Virvoituja ja alkoholittomat juomat', descriptionEn: 'Soft drinks and beverages', order: 3 },
      ],
      'Finnish': [
        { name: 'Pääruoat', nameEn: 'Main Courses', nameSv: 'Huvudrätter', description: 'Suomalaiset pääruoat', descriptionEn: 'Finnish main courses', order: 1 },
        { name: 'Jälkiruoat', nameEn: 'Desserts', nameSv: 'Efterrätter', description: 'Kotiruoat ja leivonnaiset', descriptionEn: 'Homemade desserts', order: 2 },
        { name: 'Lounaat', nameEn: 'Lunch', nameSv: 'Lunch', description: 'Arkipäivän lounasruoat', descriptionEn: 'Daily lunch specials', order: 3 },
      ],
      'Pizza': [
        { name: 'Pizzat', nameEn: 'Pizzas', nameSv: 'Pizzor', description: 'Käsinpellat pitaleivät', descriptionEn: 'Handmade stone oven pizzas', order: 1 },
        { name: 'Kebab annokset', nameEn: 'Kebab Dishes', nameSv: 'Kebabrätter', description: 'Lämmin kebab-annokset', descriptionEn: 'Warm kebab dishes', order: 2 },
        { name: 'Salaatit', nameEn: 'Salads', nameSv: 'Sallader', description: 'Tuoreet salaattia', descriptionEn: 'Fresh salads', order: 3 },
      ],
      'General': [
        { name: 'Suosikit', nameEn: 'Favorites', nameSv: 'Favoriter', description: 'Ravintolan suosikkiruoat', descriptionEn: "Restaurant's favorites", order: 1 },
        { name: 'Pääruoat', nameEn: 'Main Courses', nameSv: 'Huvudrätter', description: 'Lämpimät pääruoat', descriptionEn: 'Warm main courses', order: 2 },
        { name: 'Jälkiruoat', nameEn: 'Desserts', nameSv: 'Efterrätter', description: 'Makeat herkut', descriptionEn: 'Sweet desserts', order: 3 },
        { name: 'Juomat', nameEn: 'Beverages', nameSv: 'Drycker', description: 'Kuumat ja kylmät juomat', descriptionEn: 'Hot and cold beverages', order: 4 },
      ],
    };

    return categoryMap[cuisineType] || categoryMap['General'];
  }

  /**
   * Import parsed menu items into database
   */
  private async importParsedMenu(tenantId: string, parsedMenu: any) {
    try {
      logger.info({ tenantId, itemCount: parsedMenu.items?.length || 0 }, 'Importing parsed menu items');

      const categories = parsedMenu.categories || [];
      const items = parsedMenu.items || [];

      // Create/update categories
      const categoryIdMap = new Map<string, string>();

      for (const category of categories) {
        const result = await sql`
          INSERT INTO public.categories (tenant_id, name, name_en, name_sv, description, description_en, order_index, is_active)
          VALUES (
            ${tenantId},
            ${category.name},
            ${category.name_en || category.name},
            ${category.name_sv || category.name_en || category.name},
            ${category.description || ''},
            ${category.description_en || category.description || ''},
            ${categoryIdMap.size + 1},
            true
          )
          ON CONFLICT (tenant_id, name) DO UPDATE SET
            name_en = EXCLUDED.name_en,
            name_sv = EXCLUDED.name_sv,
            updated_at = NOW()
          RETURNING id
        `;

        if (result && result.length > 0) {
          categoryIdMap.set(category.name, result[0].id);
        }
      }

      // Create menu items
      for (const item of items) {
        // Get category ID
        const categoryId = categoryIdMap.get(item.category);

        const result = await sql`
          INSERT INTO public.menu_items (
            tenant_id, category_id, name, name_en, name_sv,
            description, description_en, description_sv,
            price, allergens, dietary, is_available, is_featured
          )
          VALUES (
            ${tenantId},
            ${categoryId || null},
            ${item.name},
            ${item.name_en || item.name},
            ${item.name_sv || item.name_en || item.name},
            ${item.description || ''},
            ${item.description_en || item.description || ''},
            ${item.description_sv || ''},
            ${item.price || 0},
            ${JSON.stringify(item.allergens || [])}::jsonb,
            ${JSON.stringify(item.dietary || [])}::jsonb,
            true,
            false
          )
          ON CONFLICT DO NOTHING
        `;

        logger.debug({ itemName: item.name }, 'Menu item imported');
      }

      logger.info({ tenantId, itemCount: items.length }, 'Menu items imported successfully');
    } catch (error) {
      logger.error({
        error: error instanceof Error ? error.message : 'Unknown error',
        tenantId,
      }, 'Error importing parsed menu');
    }
  }

  /**
   * Get default theme
   */
  private getDefaultTheme() {
    return {
      name: 'Modern Orange',
      colors: {
        primary: '#FF8C00',
        secondary: '#8B4513',
        accent: '#F5E6D3',
        background: '#ffffff',
        text: '#1f2937',
      },
    };
  }

  /**
   * Step 2a: Create GitHub repository
   */
  private async createGitHubRepo(tenant: any, data: any) {
    try {
      await db.onboardingTasks.create({
        tenant_id: tenant.id,
        task_type: 'github_repo',
        status: 'in_progress',
      });

      await this.github.createTenantRepo(tenant.slug, tenant.id);

      // Push template configuration
      await this.github.pushTemplateCode(`${tenant.slug}-site`, tenant.id, {
        tenant: {
          id: tenant.id,
          slug: tenant.slug,
          name: tenant.name,
        },
        theme: data.theme,
        domain: `${tenant.slug}.helmiesbites.com`,
      });

      logger.info({
        tenantId: tenant.id,
        slug: tenant.slug,
      }, 'GitHub repository created');
    } catch (error) {
      logger.error({
        error: error instanceof Error ? error.message : 'Unknown error',
        tenantId: tenant.id,
      }, 'Error creating GitHub repository');
      throw error;
    }
  }

  /**
   * Step 2b: Create email account
   */
  private async createEmailAccount(tenant: any, data: any) {
    try {
      await db.onboardingTasks.create({
        tenant_id: tenant.id,
        task_type: 'email_account',
        status: 'in_progress',
      });

      const emailResult = await this.hostinger.createEmailAccount({
        tenantId: tenant.id,
        tenantSlug: tenant.slug,
        domain: 'helmiesbites.com',
      });

      // Store credentials in tenant metadata
      await db.tenants.update(tenant.id, {
        metadata: {
          ...(tenant.metadata || {}),
          email: emailResult.email,
          email_password: emailResult.password,
        },
      });

      logger.info({
        tenantId: tenant.id,
        email: emailResult.email,
      }, 'Email account created');
    } catch (error) {
      logger.error({
        error: error instanceof Error ? error.message : 'Unknown error',
        tenantId: tenant.id,
      }, 'Error creating email account');
      throw error;
    }
  }

  /**
   * Step 2c: Deploy to Vercel
   */
  private async deployToVercel(tenant: any, data: any) {
    try {
      await db.onboardingTasks.create({
        tenant_id: tenant.id,
        task_type: 'vercel_deploy',
        status: 'in_progress',
      });

      const repoUrl = `https://github.com/${process.env.GITHUB_ORG}/${tenant.slug}-site`;

      const project = await this.vercel.createProject(tenant.slug, repoUrl, tenant.id);

      // Trigger initial deployment
      await this.vercel.deployProject(project.id, tenant.id);

      // Configure subdomain
      await this.vercel.configureDomain(project.id, `${tenant.slug}.helmiesbites.com`, tenant.id);

      logger.info({
        tenantId: tenant.id,
        projectId: project.id,
      }, 'Vercel deployment completed');
    } catch (error) {
      logger.error({
        error: error instanceof Error ? error.message : 'Unknown error',
        tenantId: tenant.id,
      }, 'Error deploying to Vercel');
      throw error;
    }
  }

  /**
   * Step 3: Configure domain
   */
  private async configureDomain(tenant: any, data: any) {
    try {
      const domainType = data.domainSetup?.type || 'subdomain';
      let domain: string;

      if (domainType === 'subdomain') {
        domain = `${tenant.slug}.helmiesbites.com`;

        // Create subdomain DNS record
        await this.hostinger.createSubdomain(tenant.slug, tenant.id, 'helmiesbites.com');

        await db.tenantDomains.create({
          tenant_id: tenant.id,
          domain_type: 'subdomain',
          domain,
          is_primary: true,
        });
      } else if (domainType === 'custom') {
        domain = data.domainSetup?.customDomain;

        // Configure CNAME for custom domain
        await this.hostinger.configureCNAME(domain, tenant.id);

        await db.tenantDomains.create({
          tenant_id: tenant.id,
          domain_type: 'custom',
          domain,
          is_primary: true,
        });
      } else if (domainType === 'path') {
        domain = `helmiesbites.com/${tenant.slug}`;

        await db.tenantDomains.create({
          tenant_id: tenant.id,
          domain_type: 'path',
          domain,
          is_primary: true,
        });
      }

      // Store primary domain in tenant metadata
      await db.tenants.update(tenant.id, {
        metadata: {
          ...(tenant.metadata || {}),
          primary_domain: domain,
        },
      });

      logger.info({
        tenantId: tenant.id,
        domain,
        domainType,
      }, 'Domain configured');
    } catch (error) {
      logger.error({
        error: error instanceof Error ? error.message : 'Unknown error',
        tenantId: tenant.id,
      }, 'Error configuring domain');
      // Don't throw - domain issues can be resolved later
    }
  }

  /**
   * Step 4: Send welcome email
   */
  private async sendWelcomeEmail(tenant: any) {
    try {
      const success = await this.email.sendWelcomeEmail(tenant);

      if (success) {
        logger.info({
          tenantId: tenant.id,
          email: tenant.metadata.email,
        }, 'Welcome email sent');
      } else {
        logger.warn({
          tenantId: tenant.id,
          email: tenant.metadata.email,
        }, 'Failed to send welcome email');
      }
    } catch (error) {
      logger.error({
        error: error instanceof Error ? error.message : 'Unknown error',
        tenantId: tenant.id,
      }, 'Error sending welcome email');
      // Don't throw - email failures shouldn't block onboarding
    }
  }

  /**
   * Generate URL-safe slug from name
   */
  private generateSlug(name: string): string {
    return name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '') // Remove accents
      .replace(/[^a-z0-9\s-]/g, '') // Remove special chars
      .trim()
      .replace(/\s+/g, '-') // Replace spaces with hyphens
      .replace(/-+/g, '-') // Replace multiple hyphens
      .substring(0, 50); // Max length
  }

  /**
   * Ensure slug is unique by adding suffix if needed
   */
  private async ensureUniqueSlug(baseSlug: string): Promise<string> {
    let slug = baseSlug;
    let counter = 1;
    
    while (true) {
      // Check if slug exists
      const existing = await sql`SELECT id FROM public.tenants WHERE slug = ${slug} LIMIT 1`;
      if (existing.length === 0) {
        return slug;
      }
      // Add counter suffix
      counter++;
      slug = `${baseSlug}-${counter}`;
      if (counter > 100) {
        // Safety: add random string if too many duplicates
        slug = `${baseSlug}-${Date.now().toString(36)}`;
        break;
      }
    }
    return slug;
  }

  /**
   * Calculate monthly fee based on features
   */
  private calculateMonthlyFee(features: any): number {
    let fee = 0;

    if (features.cashOnDelivery) fee += 30;
    if (features.aiAssistant) fee += 10;

    return fee;
  }

  /**
   * Generate a random secure password
   */
  private generateRandomPassword(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%';
    let password = '';
    for (let i = 0; i < 16; i++) {
      password += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return password;
  }

  /**
   * Hash password using bcrypt-compatible algorithm
   */
  private async hashPassword(password: string): Promise<string> {
    // Simple hash for now - in production use bcrypt
    const encoder = new TextEncoder();
    const data = encoder.encode(password + 'helmies-salt-2026');
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }
}

export default OnboardingPipelineService;
