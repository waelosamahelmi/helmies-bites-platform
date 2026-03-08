import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { db, logger, sql } from '../db.js';
import crypto from 'crypto';
import { OpenRouterService } from '../services/openrouter.service.js';
import { upload } from '../middleware/upload.js';

const router = Router();

// Validation schemas
const startWizardSchema = z.object({
  email: z.string().email(),
});

const wizardStepSchema = z.object({
  sessionId: z.string().uuid(),
  step: z.enum([
    'restaurant-info',
    'menu-upload',
    'images',
    'theme',
    'domain',
    'stripe',
    'review'
  ]),
  data: z.record(z.any()),
});

const aiGenerateSchema = z.object({
  sessionId: z.string().uuid(),
  input: z.string(),
  type: z.enum([
    'restaurant-info',
    'description',
    'translations'
  ]),
  language: z.string().optional().default('en'),
});

/**
 * POST /api/wizard/start
 * Initialize a new wizard session
 */
router.post('/start', async (req: Request, res: Response) => {
  try {
    const validationResult = startWizardSchema.safeParse(req.body);

    if (!validationResult.success) {
      return res.status(400).json({
        error: 'Validation Error',
        details: validationResult.error.errors,
      });
    }

    const { email } = validationResult.data;

    // Check for existing in-progress session
    const existingSessions = await db.wizardSessions.findByEmail(email);
    const existingSession = Array.isArray(existingSessions) ? existingSessions[0] : existingSessions;

    if (existingSession && existingSession.status === 'in_progress') {
      logger.info({
        sessionId: existingSession.id,
        email,
      }, 'Resuming existing wizard session');

      return res.json({
        session: existingSession,
        resumed: true,
      });
    }

    // Create new session
    const newSessions = await db.wizardSessions.create({
      email,
      step: 'restaurant-info',
      data: {},
      status: 'in_progress',
    });
    const session = Array.isArray(newSessions) ? newSessions[0] : newSessions;

    logger.info({
      sessionId: session.id,
      email,
    }, 'Started new wizard session');

    res.status(201).json({
      session,
      resumed: false,
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
    }, 'Error starting wizard');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to start wizard session',
    });
  }
});

/**
 * POST /api/wizard/step/:step
 * Submit wizard step data
 */
router.post('/step/:step', async (req: Request, res: Response) => {
  try {
    const { step } = req.params;
    const { sessionId, data } = req.body;

    if (!sessionId) {
      return res.status(400).json({
        error: 'Validation Error',
        message: 'sessionId is required',
      });
    }

    // Get existing session
    const sessionArr = await db.wizardSessions.findOne(sessionId);
    const session = Array.isArray(sessionArr) ? sessionArr[0] : sessionArr;

    if (!session) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Wizard session not found',
      });
    }

    // Merge existing data with new data
    const mergedData = {
      ...(session.data || {}),
      ...data,
      [step]: {
        ...data,
        completedAt: new Date().toISOString(),
      },
    };

    // Update session
    const updatedResults = await db.wizardSessions.update(sessionId, {
      step,
      data: mergedData,
    });
    const updated = Array.isArray(updatedResults) ? updatedResults[0] : updatedResults;

    logger.info({
      sessionId,
      step,
      email: session.email,
    }, 'Submitted wizard step');

    res.json({
      session: updated,
      message: 'Step submitted successfully',
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
      step: req.params.step,
    }, 'Error submitting wizard step');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to submit wizard step',
    });
  }
});

/**
 * POST /api/wizard/ai-generate
 * Generate content using AI
 */
router.post('/ai-generate', async (req: Request, res: Response) => {
  try {
    const validationResult = aiGenerateSchema.safeParse(req.body);

    if (!validationResult.success) {
      return res.status(400).json({
        error: 'Validation Error',
        details: validationResult.error.errors,
      });
    }

    const { sessionId, input, type, language } = validationResult.data;

    // Verify session exists
    const sessionArr = await db.wizardSessions.findOne(sessionId);
    const session = Array.isArray(sessionArr) ? sessionArr[0] : sessionArr;
    if (!session) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Wizard session not found',
      });
    }

    const aiService = new OpenRouterService();
    let result;

    switch (type) {
      case 'restaurant-info':
        result = await aiService.generateRestaurantInfo(input);
        break;
      case 'description':
        result = await aiService.generateDescription(input);
        break;
      case 'translations':
        result = await aiService.translateContent(input, language);
        break;
      default:
        return res.status(400).json({
          error: 'Invalid type',
          message: `Unknown AI generation type: ${type}`,
        });
    }

    logger.info({
      sessionId,
      type,
      language,
    }, 'AI generation completed');

    res.json({
      result,
      type,
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
      type: req.body.type,
    }, 'Error in AI generation');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to generate content',
    });
  }
});

/**
 * POST /api/wizard/parse-menu
 * Parse menu from PDF/image
 */
router.post('/parse-menu', upload.single('file'), async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.body;
    const file = req.file;

    if (!file) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'No file uploaded',
      });
    }

    if (!sessionId) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'sessionId is required',
      });
    }

    const sessionArr = await db.wizardSessions.findOne(sessionId);
    const session = Array.isArray(sessionArr) ? sessionArr[0] : sessionArr;
    if (!session) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Wizard session not found',
      });
    }

    // Use OpenRouter vision model to parse the menu
    const aiService = new OpenRouterService();

    let parsedMenu;
    if (file.mimetype.startsWith('image/')) {
      // Parse image with vision model
      parsedMenu = await aiService.parseMenuDocument({
        buffer: file.buffer,
        mimetype: file.mimetype,
      });
    } else if (file.mimetype === 'application/pdf') {
      // For PDF, we'll use a text-based approach
      // In production, you'd want to use a PDF parser first
      parsedMenu = await aiService.parseMenuFromPDF(file.buffer);
    } else {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Unsupported file type. Please upload an image or PDF.',
      });
    }

    logger.info({
      sessionId,
      categoryCount: parsedMenu.categories?.length || 0,
      itemCount: parsedMenu.items?.length || 0,
    }, 'Menu parsing completed');

    res.json({
      menu: parsedMenu,
      message: 'Menu parsed successfully',
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
    }, 'Error parsing menu');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to parse menu',
      details: process.env.NODE_ENV === 'development' ? error instanceof Error ? error.message : 'Unknown error' : undefined,
    });
  }
});

/**
 * POST /api/wizard/generate-images
 * Generate menu item images using AI
 * 
 * Body params:
 * - sessionId: string
 * - menuItems: MenuItem[]
 * - theme: any
 * - testMode: boolean (optional) - if true, only generates 1 image for debugging
 */
router.post('/generate-images', async (req: Request, res: Response) => {
  try {
    const { sessionId, menuItems, theme, testMode } = req.body;

    const sessionArr = await db.wizardSessions.findOne(sessionId);
    const session = Array.isArray(sessionArr) ? sessionArr[0] : sessionArr;
    if (!session) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Wizard session not found',
      });
    }

    const aiService = new OpenRouterService();
    
    // In test mode, only generate image for the first item
    const itemsToProcess = testMode ? [menuItems[0]] : menuItems;
    
    logger.info({
      sessionId,
      testMode: !!testMode,
      itemCount: itemsToProcess.length,
      firstItem: itemsToProcess[0]?.name,
    }, 'Starting menu image generation');

    const images = await aiService.generateMenuImages(itemsToProcess, theme);

    logger.info({
      sessionId,
      count: images.length,
      testMode: !!testMode,
    }, 'Menu image generation completed');

    res.json({
      images,
      testMode: !!testMode,
      message: testMode 
        ? `Test mode: Generated 1 image for "${itemsToProcess[0]?.name}"` 
        : `Generated ${images.length} images`,
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
    }, 'Error generating menu images');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to generate images',
      details: process.env.NODE_ENV === 'development' ? (error instanceof Error ? error.message : 'Unknown error') : undefined,
    });
  }
});

/**
 * POST /api/wizard/generate-branding
 * Generate logo and branding using AI
 */
router.post('/generate-branding', async (req: Request, res: Response) => {
  try {
    const { sessionId, restaurantName, cuisine } = req.body;

    const sessionArr = await db.wizardSessions.findOne(sessionId);
    const session = Array.isArray(sessionArr) ? sessionArr[0] : sessionArr;
    if (!session) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Wizard session not found',
      });
    }

    const aiService = new OpenRouterService();
    const branding = await aiService.generateBranding(restaurantName, cuisine);

    logger.info({
      sessionId,
      restaurantName,
    }, 'Branding generation completed');

    res.json({
      branding,
      message: 'Branding generated successfully',
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
    }, 'Error generating branding');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to generate branding',
    });
  }
});

/**
 * POST /api/wizard/complete
 * Complete wizard and trigger onboarding
 */
router.post('/complete', async (req: Request, res: Response) => {
  try {
    const { sessionId, restaurantInfo, features, menuItems, theme, domain, stripe, logoUrl, logoSvg, operatingHours } = req.body;

    const sessionArr = await db.wizardSessions.findOne(sessionId);
    const session = Array.isArray(sessionArr) ? sessionArr[0] : sessionArr;
    if (!session) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Wizard session not found',
      });
    }

    const sessionData = session.data || {};

    // Merge request body with session data - preserve logoUrl from session if not in request
    const mergedData = {
      ...sessionData,
      restaurantInfo: restaurantInfo || sessionData.restaurantInfo,
      features: features || sessionData.features,
      menuItems: menuItems || sessionData.menuItems,
      theme: theme || sessionData.theme,
      domain: domain || sessionData.domain,
      stripe: stripe || sessionData.stripe,
      // Logo: prefer request body, then session step data, then session root
      logoUrl: logoUrl || sessionData['theme']?.logoUrl || sessionData.logoUrl,
      logoSvg: logoSvg || sessionData['theme']?.logoSvg || sessionData.logoSvg,
      // Operating hours
      operatingHours: operatingHours || sessionData.operatingHours || sessionData['features']?.operatingHours,
    };

    // Update session with merged data
    await sql`UPDATE public.wizard_sessions SET status = 'completed', step = 'completed', data = ${mergedData} WHERE id = ${sessionId}`;

    // Import and trigger onboarding pipeline
    const { OnboardingPipelineService } = await import('../services/onboarding-pipeline.service.js');
    const pipeline = new OnboardingPipelineService();

    const tenant = await pipeline.completeWizard(sessionId);

    logger.info({
      sessionId,
      tenantId: tenant.id,
      email: session.email,
    }, 'Wizard completed and onboarding started');

    res.json({
      tenant,
      message: 'Wizard completed successfully',
      adminUrl: `https://${tenant.slug}.helmiesbites.com/admin`,
      siteUrl: `https://${tenant.slug}.helmiesbites.com`,
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
      sessionId: req.body.sessionId,
    }, 'Error completing wizard');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to complete wizard',
    });
  }
});

/**
 * GET /api/wizard/session/:id
 * Get wizard session data
 */
router.get('/session/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const sessionArr = await db.wizardSessions.findOne(id);
    const session = Array.isArray(sessionArr) ? sessionArr[0] : sessionArr;

    if (!session) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Wizard session not found',
      });
    }

    // Get onboarding tasks if tenant exists
    let onboardingTasks = [];
    if (session.tenant_id) {
      onboardingTasks = await db.onboardingTasks.findByTenantId(session.tenant_id);
    }

    res.json({
      session,
      onboardingTasks,
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
      sessionId: req.params.id,
    }, 'Error retrieving wizard session');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to retrieve session',
    });
  }
});

/**
 * POST /api/wizard/session/:id/abandon
 * Abandon wizard session
 */
router.post('/session/:id/abandon', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const updatedResults = await db.wizardSessions.update(id, {
      status: 'abandoned',
    });
    const session = Array.isArray(updatedResults) ? updatedResults[0] : updatedResults;

    logger.info({
      sessionId: id,
    }, 'Wizard session abandoned');

    res.json({
      session,
      message: 'Session abandoned',
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
      sessionId: req.params.id,
    }, 'Error abandoning wizard session');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to abandon session',
    });
  }
});

export default router;
