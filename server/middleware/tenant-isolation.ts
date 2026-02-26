import { Request, Response, NextFunction } from 'express';
import { sql } from '../db.js';
import { logger } from '../db.js';

/**
 * Tenant isolation middleware
 * Extracts tenant from subdomain and sets request context
 */
export async function tenantIsolation(req: Request, res: Response, next: NextFunction) {
  try {
    const host = req.headers.host || '';
    const subdomain = host.split('.')[0];

    // Skip for main domain, admin, api, etc.
    const skipSubdomains = ['helmiesbites', 'bites', 'www', 'admin', 'api', 'studio', 'localhost', '127', '192', '10'];

    if (skipSubdomains.some(skip => subdomain.includes(skip))) {
      req.tenant = null;
      req.tenantId = null;
      return next();
    }

    // Look up tenant by slug (subdomain)
    const result = await sql`
      SELECT id, slug, name, status, features, subscription_tier
      FROM public.tenants
      WHERE slug = ${subdomain} AND status = 'active'
      LIMIT 1
    `;

    if (result.length === 0) {
      // Tenant not found or inactive
      req.tenant = null;
      req.tenantId = null;
      return next();
    }

    // Set tenant context
    req.tenant = result[0];
    req.tenantId = result[0].id;

    // Set as config for Supabase queries
    req.headers['x-tenant-id'] = result[0].id;

    logger.debug({
      tenantId: result[0].id,
      slug: result[0].slug,
    }, 'Tenant context set from subdomain');

    next();
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
      host: req.headers.host,
    }, 'Error in tenant isolation middleware');

    // Continue without tenant context on error
    req.tenant = null;
    req.tenantId = null;
    next();
  }
}

/**
 * Require tenant middleware
 * Returns 404 if tenant context is not set
 */
export function requireTenant(req: Request, res: Response, next: NextFunction) {
  if (!req.tenant || !req.tenantId) {
    return res.status(404).json({
      error: 'Tenant Not Found',
      message: 'The requested restaurant does not exist or is not active.',
    });
  }

  next();
}

/**
 * Admin tenant access middleware
 * Allows Helmies admins to access any tenant
 */
export function adminTenantAccess(req: Request, res: Response, next: NextFunction) {
  const isAdmin = req.headers['x-is-admin'] === 'true' || req.user?.role === 'helmies_admin';

  if (!isAdmin && !req.tenantId) {
    return res.status(403).json({
      error: 'Forbidden',
      message: 'You do not have permission to access this resource.',
    });
  }

  next();
}

// Extend Express Request type
declare global {
  namespace Express {
    interface Request {
      tenant?: {
        id: string;
        slug: string;
        name: string;
        status: string;
        features: any;
        subscription_tier: string;
      };
      tenantId?: string;
      user?: {
        id: string;
        email: string;
        role: string;
        tenant_id?: string;
      };
      id?: string;
      startTime?: number;
    }
  }
}

export default tenantIsolation;
