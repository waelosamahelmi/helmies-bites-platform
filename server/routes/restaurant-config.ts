import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { db, logger } from '../db.js';
import { authMiddleware, requireTenantAdmin } from '../middleware/auth.js';

const router = Router();

// Validation schemas
const createRestaurantConfigSchema = z.object({
  tenant_id: z.string().uuid(),
  name: z.string().min(1).max(255),
  name_en: z.string().max(255).optional(),
  description: z.string().optional(),
  description_en: z.string().optional(),
  logo_url: z.string().url().optional(),
  logo_public_id: z.string().optional(),
  address: z.object({
    street: z.string().optional(),
    city: z.string().optional(),
    postal_code: z.string().optional(),
    country: z.string().default('Finland'),
    latitude: z.number().optional(),
    longitude: z.number().optional(),
  }).optional(),
  contact: z.object({
    phone: z.string().optional(),
    email: z.string().email().optional(),
    website: z.string().url().optional(),
  }).optional(),
  operating_hours: z.object({
    monday: z.string().optional(),
    tuesday: z.string().optional(),
    wednesday: z.string().optional(),
    thursday: z.string().optional(),
    friday: z.string().optional(),
    saturday: z.string().optional(),
    sunday: z.string().optional(),
  }).optional(),
  business_info: z.object({
    company_number: z.string().optional(),
    tax_id: z.string().optional(),
    vat_id: z.string().optional(),
    industry: z.string().optional(),
    founding_year: z.number().int().optional(),
  }).optional(),
  social_links: z.object({
    facebook: z.string().url().optional(),
    instagram: z.string().url().optional(),
    twitter: z.string().url().optional(),
    linkedin: z.string().url().optional(),
  }).optional(),
  theme: z.object({
    primary_color: z.string().default('#ff6b35'),
    secondary_color: z.string().default('#f7931e'),
    background_color: z.string().default('#ffffff'),
    text_color: z.string().default('#000000'),
    accent_color: z.string().default('#ff6b35'),
  }).optional(),
  features: z.object({
    cash_on_delivery: z.boolean().default(false),
    card_on_delivery: z.boolean().default(true),
    online_payment: z.boolean().default(true),
    reservations: z.boolean().default(false),
    takeaway: z.boolean().default(true),
    delivery: z.boolean().default(true),
    lunch_service: z.boolean().default(false),
    ai_menu_images: z.boolean().default(false),
    loyalty_program: z.boolean().default(false),
  }).optional(),
  default_order_settings: z.object({
    payment_method: z.enum(['stripe', 'card_on_delivery', 'cash']).default('stripe'),
    delivery_fee: z.number().min(0).default(0),
    free_delivery_threshold: z.number().min(0).optional(),
    tip_percentage: z.number().min(0).max(100).optional(),
    include_vat: z.boolean().default(true),
  }).optional(),
  settings: z.object({
    currency: z.string().default('EUR'),
    language: z.string().default('fi'),
    timezone: z.string().default('Europe/Helsinki'),
    locale: z.string().default('fi-FI'),
    order_prefix: z.string().default('ORD'),
    auto_confirm_orders: z.boolean().default(true),
    order_timeout_minutes: z.number().int().min(5).default(30),
  }).optional(),
  metadata: z.record(z.any()).optional(),
});

const updateRestaurantConfigSchema = createRestaurantConfigSchema.partial().extend({
  tenant_id: z.string().uuid(),
});

/**
 * GET /api/restaurant-config
 * Get restaurant configuration (tenant admin)
 */
router.get('/', authMiddleware, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const tenantId = req.user?.tenant_id;

    if (!tenantId) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'Tenant ID is required',
      });
    }

    const config = await db.restaurantConfig.findOne({ tenant_id: tenantId });

    if (!config) {
      // Return default configuration if none exists
      const defaultConfig = {
        name: '',
        name_en: '',
        description: '',
        description_en: '',
        logo_url: '',
        address: {
          street: '',
          city: '',
          postal_code: '',
          country: 'Finland',
        },
        contact: {
          phone: '',
          email: '',
          website: '',
        },
        operating_hours: {
          monday: '',
          tuesday: '',
          wednesday: '',
          thursday: '',
          friday: '',
          saturday: '',
          sunday: '',
        },
        business_info: {},
        social_links: {},
        theme: {
          primary_color: '#ff6b35',
          secondary_color: '#f7931e',
          background_color: '#ffffff',
          text_color: '#000000',
          accent_color: '#ff6b35',
        },
        features: {
          cash_on_delivery: false,
          card_on_delivery: true,
          online_payment: true,
          reservations: false,
          takeaway: true,
          delivery: true,
          lunch_service: false,
          ai_menu_images: false,
          loyalty_program: false,
        },
        default_order_settings: {
          payment_method: 'stripe',
          delivery_fee: 0,
          free_delivery_threshold: 0,
          tip_percentage: 0,
          include_vat: true,
        },
        settings: {
          currency: 'EUR',
          language: 'fi',
          timezone: 'Europe/Helsinki',
          locale: 'fi-FI',
          order_prefix: 'ORD',
          auto_confirm_orders: true,
          order_timeout_minutes: 30,
        },
      };
      return res.json({
        config: defaultConfig,
        message: 'No configuration found, returning defaults',
      });
    }

    logger.info({
      tenantId,
      userId: req.user?.id,
    }, 'Retrieved restaurant configuration');

    res.json({
      config,
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
      tenantId: req.user?.tenant_id,
    }, 'Error retrieving restaurant configuration');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to retrieve restaurant configuration',
    });
  }
});

/**
 * GET /api/restaurant-config/public
 * Get public restaurant configuration (no auth required)
 */
router.get('/public', async (req: Request, res: Response) => {
  try {
    // Extract tenant from subdomain or header
    const tenantSlug = req.headers['x-tenant-slug'] as string;

    if (!tenantSlug) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Tenant not specified',
      });
    }

    const tenant = await db.tenants.findOne({ slug: tenantSlug });
    if (!tenant) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Tenant not found',
      });
    }

    const config = await db.restaurantConfig.findOne({ tenant_id: tenant.id });

    if (!config) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Restaurant configuration not found',
      });
    }

    // Return only public information
    const publicConfig = {
      name: config.name,
      name_en: config.name_en,
      description: config.description,
      description_en: config.description_en,
      logo_url: config.logo_url,
      address: config.address,
      contact: {
        phone: config.contact?.phone,
        email: config.contact?.email,
        website: config.contact?.website,
      },
      operating_hours: config.operating_hours,
      social_links: config.social_links,
      theme: config.theme,
      features: {
        reservations: config.features?.reservations,
        takeaway: config.features?.takeaway,
        delivery: config.features?.delivery,
        lunch_service: config.features?.lunch_service,
      },
    };

    logger.info({
      tenantId: tenant.id,
    }, 'Retrieved public restaurant configuration');

    res.json({
      config: publicConfig,
      tenant: {
        id: tenant.id,
        slug: tenant.slug,
        name: tenant.name,
      },
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
    }, 'Error retrieving public restaurant configuration');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to retrieve restaurant configuration',
    });
  }
});

/**
 * POST /api/restaurant-config
 * Create or update restaurant configuration (tenant admin)
 */
router.post('/', authMiddleware, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const validationResult = createRestaurantConfigSchema.safeParse(req.body);

    if (!validationResult.success) {
      return res.status(400).json({
        error: 'Validation Error',
        details: validationResult.error.errors,
      });
    }

    const data = validationResult.data;
    const tenantId = req.user?.tenant_id;

    // Ensure tenant is set
    data.tenant_id = tenantId;

    // Check if configuration already exists
    const existingConfig = await db.restaurantConfig.findOne({ tenant_id: tenantId });

    if (existingConfig) {
      // Update existing configuration
      const config = await db.restaurantConfig.update(existingConfig.id, data);

      logger.info({
        configId: existingConfig.id,
        tenantId,
        userId: req.user?.id,
      }, 'Updated restaurant configuration');

      res.json({
        config,
        message: 'Restaurant configuration updated successfully',
      });
    } else {
      // Create new configuration
      const config = await db.restaurantConfig.create(data);

      logger.info({
        configId: config.id,
        tenantId,
        userId: req.user?.id,
      }, 'Created restaurant configuration');

      res.status(201).json({
        config,
        message: 'Restaurant configuration created successfully',
      });
    }
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
      tenantId: req.user?.tenant_id,
    }, 'Error creating/updating restaurant configuration');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to create/update restaurant configuration',
    });
  }
});

/**
 * PUT /api/restaurant-config/:id
 * Update restaurant configuration (tenant admin)
 */
router.put('/:id', authMiddleware, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const tenantId = req.user?.tenant_id;

    const validationResult = updateRestaurantConfigSchema.safeParse(req.body);

    if (!validationResult.success) {
      return res.status(400).json({
        error: 'Validation Error',
        details: validationResult.error.errors,
      });
    }

    const data = validationResult.data;

    // Verify configuration exists and belongs to tenant
    const existingConfig = await db.restaurantConfig.findOne({ id, tenant_id: tenantId });
    if (!existingConfig) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Restaurant configuration not found',
      });
    }

    const config = await db.restaurantConfig.update(id, data);

    logger.info({
      configId: id,
      tenantId,
      userId: req.user?.id,
      changes: Object.keys(data),
    }, 'Updated restaurant configuration');

    res.json({
      config,
      message: 'Restaurant configuration updated successfully',
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
      configId: req.params.id,
    }, 'Error updating restaurant configuration');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to update restaurant configuration',
    });
  }
});

/**
 * GET /api/restaurant-config/:id
 * Get restaurant configuration by ID (admin)
 */
router.get('/:id', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const tenantId = req.user?.tenant_id;

    const config = await db.restaurantConfig.findOne({ id });

    if (!config) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Restaurant configuration not found',
      });
    }

    // Check authorization
    const isAdmin = req.user?.role === 'helmies_admin' || req.user?.role === 'admin';
    const isOwnTenant = config.tenant_id === tenantId;

    if (!isAdmin && !isOwnTenant) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'You do not have permission to view this configuration',
      });
    }

    logger.info({
      configId: id,
      userId: req.user?.id,
    }, 'Retrieved restaurant configuration by ID');

    res.json({
      config,
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
      configId: req.params.id,
    }, 'Error retrieving restaurant configuration');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to retrieve restaurant configuration',
    });
  }
});

/**
 * GET /api/restaurant-config/status
 * Check if restaurant configuration is complete (tenant admin)
 */
router.get('/status', authMiddleware, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const tenantId = req.user?.tenant_id;

    if (!tenantId) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'Tenant ID is required',
      });
    }

    const config = await db.restaurantConfig.findOne({ tenant_id: tenantId });

    if (!config) {
      return res.json({
        is_complete: false,
        missing_fields: ['name', 'address'],
        message: 'Restaurant configuration not found',
      });
    }

    // Check required fields
    const requiredFields = ['name'];
    const missingFields = requiredFields.filter(field => !config[field as keyof typeof config]);

    // Check if contact information exists
    if (!config.contact?.phone && !config.contact?.email) {
      missingFields.push('contact');
    }

    // Check if operating hours exist
    if (!config.operating_hours || Object.keys(config.operating_hours).length === 0) {
      missingFields.push('operating_hours');
    }

    const isComplete = missingFields.length === 0;

    logger.info({
      tenantId,
      isComplete,
      missingFields,
    }, 'Checked restaurant configuration status');

    res.json({
      is_complete: isComplete,
      missing_fields: missingFields,
      message: isComplete ? 'Restaurant configuration is complete' : 'Restaurant configuration needs attention',
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
      tenantId: req.user?.tenant_id,
    }, 'Error checking restaurant configuration status');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to check restaurant configuration status',
    });
  }
});

export default router;