import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { logger } from '../db.js';
import { supabase } from '../db.js';

interface JwtPayload {
  userId: string;
  email: string;
  role: string;
  tenantId?: string;
  isAdmin?: boolean;
}

/**
 * JWT Authentication Middleware
 * Verifies JWT token and sets user context
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Missing or invalid authorization header',
      });
    }

    const token = authHeader.substring(7);

    // Verify JWT token
    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET || 'your-secret-key'
    ) as JwtPayload;

    // Set user context
    req.user = {
      id: decoded.userId,
      email: decoded.email,
      role: decoded.role,
      tenant_id: decoded.tenantId,
    };

    logger.debug({
      userId: decoded.userId,
      email: decoded.email,
      role: decoded.role,
    }, 'User authenticated via JWT');

    next();
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      return res.status(401).json({
        error: 'Token Expired',
        message: 'Your authentication token has expired. Please log in again.',
      });
    }

    if (error instanceof jwt.JsonWebTokenError) {
      return res.status(401).json({
        error: 'Invalid Token',
        message: 'Your authentication token is invalid.',
      });
    }

    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
    }, 'Authentication error');

    return res.status(401).json({
      error: 'Authentication Failed',
      message: 'Could not authenticate your request.',
    });
  }
}

/**
 * Optional authentication middleware
 * Sets user context if token is present, but doesn't require it
 */
export function optionalAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    return next();
  }

  try {
    const token = authHeader.substring(7);
    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET || 'your-secret-key'
    ) as JwtPayload;

    req.user = {
      id: decoded.userId,
      email: decoded.email,
      role: decoded.role,
      tenant_id: decoded.tenantId,
    };
  } catch (error) {
    // Ignore errors, just don't set user context
  }

  next();
}

/**
 * Require admin role middleware
 * Returns 403 if user is not an admin
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'You must be logged in to access this resource.',
    });
  }

  if (req.user.role !== 'helmies_admin' && req.user.role !== 'admin') {
    return res.status(403).json({
      error: 'Forbidden',
      message: 'You do not have permission to access this resource.',
    });
  }

  next();
}

/**
 * Require tenant admin role middleware
 * Returns 403 if user is not a tenant admin or platform admin
 */
export function requireTenantAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'You must be logged in to access this resource.',
    });
  }

  const isAdmin = req.user.role === 'helmies_admin' || req.user.role === 'admin';
  const isTenantAdmin = req.user.role === 'tenant_admin';

  if (!isAdmin && !isTenantAdmin) {
    return res.status(403).json({
      error: 'Forbidden',
      message: 'You do not have permission to access this resource.',
    });
  }

  // For tenant admins, verify they belong to the correct tenant
  if (isTenantAdmin && req.tenantId && req.user.tenant_id !== req.tenantId) {
    return res.status(403).json({
      error: 'Forbidden',
      message: 'You do not have permission to access this tenant.',
    });
  }

  next();
}

/**
 * Hash password using bcrypt
 */
export async function hashPassword(password: string): Promise<string> {
  const rounds = parseInt(process.env.BCRYPT_ROUNDS || '12');
  return bcrypt.hash(password, rounds);
}

/**
 * Compare password with hash
 */
export async function comparePassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/**
 * Generate JWT token
 */
export function generateToken(payload: JwtPayload): string {
  return jwt.sign(payload, process.env.JWT_SECRET || 'your-secret-key', {
    expiresIn: '7d',
  });
}

/**
 * Generate refresh token (longer expiration)
 */
export function generateRefreshToken(payload: JwtPayload): string {
  return jwt.sign(payload, process.env.JWT_SECRET || 'your-secret-key', {
    expiresIn: '30d',
  });
}

/**
 * Verify JWT token
 */
export function verifyToken(token: string): JwtPayload | null {
  try {
    return jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key') as JwtPayload;
  } catch (error) {
    return null;
  }
}

export default authMiddleware;
