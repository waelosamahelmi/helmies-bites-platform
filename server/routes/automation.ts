import { Router, Request, Response } from 'express';
import { db, logger, sql } from '../db.js';
import { GitHubService } from '../services/github.service.js';
import { VercelService } from '../services/vercel.service.js';
import { HostingerApiService } from '../services/hostinger-api.service.js';
import { body, param, validationResult } from 'express-validator';

const router = Router();

// Initialize services
const githubService = new GitHubService();
const vercelService = new VercelService();
const hostingerService = new HostingerApiService();

/**
 * GET /api/automation/status/:taskId
 * Check automation task status
 */
router.get('/status/:taskId',
  [param('taskId').isUUID()],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const { taskId } = req.params;

      const tasks = await sql`
        SELECT * FROM public.onboarding_tasks
        WHERE id = ${taskId}
      `;

      if (!tasks || tasks.length === 0) {
        return res.status(404).json({ error: 'Task not found' });
      }

      const task = tasks[0];

      res.json({
        id: task.id,
        taskType: task.task_type,
        status: task.status,
        data: task.data,
        errorMessage: task.error_message,
        createdAt: task.created_at,
        updatedAt: task.updated_at
      });
    } catch (error) {
      logger.error(`Failed to get task status for ${req.params.taskId}:`, error);
      res.status(500).json({
        error: 'Failed to get task status',
        details: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }
);

/**
 * GET /api/automation/tenant/:tenantId/tasks
 * Get all automation tasks for a tenant
 */
router.get('/tenant/:tenantId/tasks',
  [param('tenantId').isUUID()],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const { tenantId } = req.params;

      const tasks = await db.onboardingTasks.findByTenantId(tenantId);

      res.json({
        tasks: tasks.map((t: any) => ({
          id: t.id,
          taskType: t.task_type,
          status: t.status,
          data: t.data,
          errorMessage: t.error_message,
          createdAt: t.created_at,
          updatedAt: t.updated_at
        }))
      });
    } catch (error) {
      logger.error(`Failed to get tasks for tenant ${req.params.tenantId}:`, error);
      res.status(500).json({
        error: 'Failed to get tasks',
        details: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }
);

/**
 * POST /api/automation/github/repo
 * Create GitHub repository
 */
router.post('/github/repo',
  [
    body('tenantId').isUUID(),
    body('slug').trim().isLength({ min: 3, max: 100 }),
    body('tenantName').trim().isLength({ min: 1, max: 255 })
  ],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const { tenantId, slug, tenantName } = req.body;

      // Create task record
      const task = await db.onboardingTasks.create({
        tenant_id: tenantId,
        task_type: 'github_repo',
        status: 'in_progress',
        data: { slug, tenantName }
      });

      try {
        // Create GitHub repository
        const repo = await githubService.createTenantRepo(slug, tenantId);

        // Update task as completed
        await db.onboardingTasks.update(
          (task as any)[0].id,
          {
            status: 'completed',
            data: {
              repoUrl: repo.html_url,
              repoName: repo.full_name,
              cloneUrl: repo.clone_url
            }
          }
        );

        res.json({
          success: true,
          taskId: (task as any)[0].id,
          repo: {
            url: repo.html_url,
            name: repo.full_name,
            cloneUrl: repo.clone_url
          }
        });
      } catch (error) {
        // Update task as failed
        await db.onboardingTasks.update(
          (task as any)[0].id,
          {
            status: 'failed',
            error_message: error instanceof Error ? error.message : 'Unknown error'
          }
        );
        throw error;
      }
    } catch (error) {
      logger.error('Failed to create GitHub repo:', error);
      res.status(500).json({
        error: 'Failed to create GitHub repository',
        details: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }
);

/**
 * POST /api/automation/vercel/deploy
 * Deploy to Vercel
 */
router.post('/vercel/deploy',
  [
    body('tenantId').isUUID(),
    body('slug').trim().isLength({ min: 3, max: 100 }),
    body('repoUrl').isURL(),
    body('domainType').isIn(['subdomain', 'path', 'custom']),
    body('domain').optional().isString()
  ],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const { tenantId, slug, repoUrl, domainType, domain } = req.body;

      // Create task record
      const task = await db.onboardingTasks.create({
        tenant_id: tenantId,
        task_type: 'vercel_deploy',
        status: 'in_progress',
        data: { slug, repoUrl, domainType, domain }
      });

      try {
        // Deploy to Vercel
        const deployment = await vercelService.deployTenantSite({
          tenantId,
          slug,
          repoUrl,
          domainType,
          domain: domain || `${slug}.helmiesbites.com`
        });

        // Update task as completed
        await db.onboardingTasks.update(
          (task as any)[0].id,
          {
            status: 'completed',
            data: {
              projectUrl: deployment.url,
              deploymentUrl: deployment.deployUrl,
              domain: deployment.domain
            }
          }
        );

        res.json({
          success: true,
          taskId: (task as any)[0].id,
          deployment
        });
      } catch (error) {
        // Update task as failed
        await db.onboardingTasks.update(
          (task as any)[0].id,
          {
            status: 'failed',
            error_message: error instanceof Error ? error.message : 'Unknown error'
          }
        );
        throw error;
      }
    } catch (error) {
      logger.error('Failed to deploy to Vercel:', error);
      res.status(500).json({
        error: 'Failed to deploy to Vercel',
        details: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }
);

/**
 * POST /api/automation/email/create
 * Create email account
 */
router.post('/email/create',
  [
    body('tenantId').isUUID(),
    body('slug').trim().isLength({ min: 3, max: 50 }),
    body('password').trim().isLength({ min: 8 })
  ],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const { tenantId, slug, password } = req.body;

      // Create task record
      const task = await db.onboardingTasks.create({
        tenant_id: tenantId,
        task_type: 'email_creation',
        status: 'in_progress',
        data: { email: `${slug}@helmiesbites.com` }
      });

      try {
        // Create email account via Hostinger
        const email = await hostingerService.createEmailAccount({
          domain: 'helmiesbites.com',
          email: slug,
          password
        });

        // Update task as completed
        await db.onboardingTasks.update(
          (task as any)[0].id,
          {
            status: 'completed',
            data: {
              email: email.address,
              quota: email.quota
            }
          }
        );

        res.json({
          success: true,
          taskId: (task as any)[0].id,
          email: {
            address: email.address,
            quota: email.quota
          }
        });
      } catch (error) {
        // Update task as failed
        await db.onboardingTasks.update(
          (task as any)[0].id,
          {
            status: 'failed',
            error_message: error instanceof Error ? error.message : 'Unknown error'
          }
        );
        throw error;
      }
    } catch (error) {
      logger.error('Failed to create email account:', error);
      res.status(500).json({
        error: 'Failed to create email account',
        details: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }
);

/**
 * POST /api/automation/domain/verify
 * Verify domain DNS
 */
router.post('/domain/verify',
  [
    body('domain').trim().isString(),
    body('tenantId').isUUID().optional()
  ],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const { domain, tenantId } = req.body;

      // Verify DNS via Hostinger API
      const result = await hostingerService.verifyDNS(domain);

      // Update domain record in database if tenantId provided
      if (tenantId && result.verified) {
        await sql`
          UPDATE public.tenant_domains
          SET dns_verified = true, ssl_status = 'verified'
          WHERE tenant_id = ${tenantId} AND domain = ${domain}
        `;
      }

      res.json({
        success: true,
        domain,
        verified: result.verified,
        dnsRecords: result.records
      });
    } catch (error) {
      logger.error('Failed to verify domain:', error);
      res.status(500).json({
        error: 'Failed to verify domain',
        details: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }
);

/**
 * POST /api/automation/domain/create
 * Create domain/subdomain record
 */
router.post('/domain/create',
  [
    body('tenantId').isUUID(),
    body('domainType').isIn(['subdomain', 'path', 'custom']),
    body('domain').trim().isString()
  ],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const { tenantId, domainType, domain, isPrimary = false } = req.body;

      // Create domain record
      const result = await db.tenantDomains.create({
        tenant_id: tenantId,
        domain_type: domainType,
        domain,
        is_primary: isPrimary,
        ssl_status: 'pending',
        dns_verified: false
      });

      if (!result || result.length === 0) {
        throw new Error('Failed to create domain record');
      }

      // Create DNS records via Hostinger
      const dnsTask = await db.onboardingTasks.create({
        tenant_id: tenantId,
        task_type: 'dns_configuration',
        status: 'in_progress',
        data: { domain, domainType }
      });

      try {
        if (domainType === 'subdomain') {
          await hostingerService.createSubdomain(domain);
        }

        // Update task
        await db.onboardingTasks.update(
          (dnsTask as any)[0].id,
          { status: 'completed' }
        );

        res.json({
          success: true,
          domain: {
            id: (result as any)[0].id,
            domain: (result as any)[0].domain,
            domainType: (result as any)[0].domain_type,
            isPrimary: (result as any)[0].is_primary
          }
        });
      } catch (dnsError) {
        await db.onboardingTasks.update(
          (dnsTask as any)[0].id,
          {
            status: 'failed',
            error_message: dnsError instanceof Error ? dnsError.message : 'Unknown error'
          }
        );
        throw dnsError;
      }
    } catch (error) {
      logger.error('Failed to create domain:', error);
      res.status(500).json({
        error: 'Failed to create domain',
        details: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }
);

/**
 * POST /api/automation/run-pipeline
 * Run the complete onboarding automation pipeline
 */
router.post('/run-pipeline',
  [
    body('tenantId').isUUID(),
    body('config').isObject()
  ],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const { tenantId, config } = req.body;

      // Get tenant info
      const tenants = await db.tenants.findOne({ id: tenantId });
      if (!tenants || tenants.length === 0) {
        return res.status(404).json({ error: 'Tenant not found' });
      }

      const tenant = tenants[0];

      // Start pipeline asynchronously
      runOnboardingPipeline(tenantId, tenant.slug, tenant.name, config)
        .then(() => logger.info(`Onboarding pipeline completed for ${tenant.slug}`))
        .catch((error) => logger.error(`Onboarding pipeline failed for ${tenant.slug}:`, error));

      res.json({
        success: true,
        message: 'Onboarding pipeline started',
        tenantId,
        slug: tenant.slug
      });
    } catch (error) {
      logger.error('Failed to start onboarding pipeline:', error);
      res.status(500).json({
        error: 'Failed to start pipeline',
        details: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }
);

/**
 * Run the onboarding pipeline asynchronously
 */
async function runOnboardingPipeline(
  tenantId: string,
  slug: string,
  tenantName: string,
  config: any
) {
  const tasks: Promise<void>[] = [];

  // GitHub repo creation
  if (config.createRepo !== false) {
    tasks.push(
      (async () => {
        try {
          await githubService.createTenantRepo(slug, tenantId);
          await db.onboardingTasks.updateByTenantAndType(
            tenantId,
            'github_repo',
            { status: 'completed' }
          );
        } catch (error) {
          await db.onboardingTasks.updateByTenantAndType(
            tenantId,
            'github_repo',
            {
              status: 'failed',
              error_message: error instanceof Error ? error.message : 'Unknown error'
            }
          );
        }
      })()
    );
  }

  // Vercel deployment
  if (config.deployToVercel !== false) {
    tasks.push(
      (async () => {
        try {
          await vercelService.deployTenantSite({
            tenantId,
            slug,
            repoUrl: `https://github.com/${process.env.GITHUB_ORG}/${slug}-site`,
            domainType: config.domainType || 'subdomain',
            domain: config.domain || `${slug}.helmiesbites.com`
          });
          await db.onboardingTasks.updateByTenantAndType(
            tenantId,
            'vercel_deploy',
            { status: 'completed' }
          );
        } catch (error) {
          await db.onboardingTasks.updateByTenantAndType(
            tenantId,
            'vercel_deploy',
            {
              status: 'failed',
              error_message: error instanceof Error ? error.message : 'Unknown error'
            }
          );
        }
      })()
    );
  }

  // Email creation
  if (config.createEmail !== false) {
    tasks.push(
      (async () => {
        try {
          await hostingerService.createEmailAccount({
            domain: 'helmiesbites.com',
            email: slug,
            password: config.emailPassword || generatePassword()
          });
          await db.onboardingTasks.updateByTenantAndType(
            tenantId,
            'email_creation',
            { status: 'completed' }
          );
        } catch (error) {
          await db.onboardingTasks.updateByTenantAndType(
            tenantId,
            'email_creation',
            {
              status: 'failed',
              error_message: error instanceof Error ? error.message : 'Unknown error'
            }
          );
        }
      })()
    );
  }

  // Wait for all tasks to complete
  await Promise.all(tasks);

  // Update tenant status
  await db.tenants.update(tenantId, { status: 'active' });
}

/**
 * Generate a random password
 */
function generatePassword(length = 16): string {
  const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
  let password = '';
  for (let i = 0; i < length; i++) {
    password += charset.charAt(Math.floor(Math.random() * charset.length));
  }
  return password;
}

export default router;
