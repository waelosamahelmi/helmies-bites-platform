import { logger } from '../db.js';
import { db } from '../db.js';
import crypto from 'crypto';

/**
 * Hostinger hPanel API Service
 * Handles email account creation and domain configuration via Hostinger API
 */
export class HostingerApiService {
  private apiKey: string;
  private apiBaseUrl: string;

  constructor() {
    this.apiKey = process.env.HOSTINGER_API_KEY || '';
    this.apiBaseUrl = process.env.HOSTINGER_API_BASE || 'https://api.hostinger.com/v1';

    if (!this.apiKey) {
      logger.warn('HOSTINGER_API_KEY not set - email/domain automation will be mocked');
    }
  }

  /**
   * Create email account for a tenant
   */
  async createEmailAccount(config: {
    tenantId: string;
    tenantSlug: string;
    domain: string;
    password?: string;
  }): Promise<{ email: string; password: string }> {
    try {
      const { tenantId, tenantSlug, domain, password } = config;
      const email = `${tenantSlug}@${domain}`;
      const generatedPassword = password || this.generateStrongPassword();

      logger.info({
        tenantId,
        tenantSlug,
        email,
      }, 'Creating Hostinger email account');

      if (!this.apiKey) {
        // Mock implementation when API key is not available
        logger.warn('Hostinger API key not configured - returning mock email credentials');

        await db.onboardingTasks.updateByTenantAndType(tenantId, 'email_account', {
          status: 'completed',
          data: {
            email,
            password: generatedPassword,
            mocked: true,
          },
        });

        return { email, password: generatedPassword };
      }

      // Real API implementation
      const response = await fetch(`${this.apiBaseUrl}/domains/${domain}/emails`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: tenantSlug,
          password: generatedPassword,
          quota: 1024, // 1GB quota
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Hostinger API error: ${response.statusText} - ${errorText}`);
      }

      const result = await response.json();

      logger.info({
        tenantId,
        email,
        accountId: result.id,
      }, 'Hostinger email account created');

      // Update onboarding task
      await db.onboardingTasks.updateByTenantAndType(tenantId, 'email_account', {
        status: 'completed',
        data: {
          email,
          password: generatedPassword,
          accountId: result.id,
        },
      });

      return { email, password: generatedPassword };
    } catch (error) {
      logger.error({
        error: error instanceof Error ? error.message : 'Unknown error',
        config,
      }, 'Error creating Hostinger email account');

      await db.onboardingTasks.updateByTenantAndType(config.tenantId, 'email_account', {
        status: 'failed',
        error_message: error instanceof Error ? error.message : 'Unknown error',
      });

      throw error;
    }
  }

  /**
   * Create subdomain
   */
  async createSubdomain(tenantSlug: string, tenantId: string, baseDomain: string) {
    try {
      const subdomain = `${tenantSlug}.${baseDomain}`;

      logger.info({
        tenantSlug,
        tenantId,
        subdomain,
      }, 'Creating Hostinger subdomain');

      if (!this.apiKey) {
        logger.warn('Hostinger API key not configured - returning mock subdomain');

        await db.onboardingTasks.updateByTenantAndType(tenantId, 'domain_setup', {
          status: 'completed',
          data: {
            subdomain,
            mocked: true,
          },
        });

        return { subdomain };
      }

      // Real API implementation - Create DNS A record
      const response = await fetch(`${this.apiBaseUrl}/domains/${baseDomain}/dns`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          type: 'A',
          host: tenantSlug,
          target: process.env.VERCEL_SERVER_IP || '76.76.21.21', // Vercel's IP
          ttl: 3600,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Hostinger API error: ${response.statusText} - ${errorText}`);
      }

      const result = await response.json();

      logger.info({
        tenantSlug,
        subdomain,
        recordId: result.id,
      }, 'Hostinger subdomain created');

      return { subdomain };
    } catch (error) {
      logger.error({
        error: error instanceof Error ? error.message : 'Unknown error',
        tenantSlug,
        tenantId,
      }, 'Error creating Hostinger subdomain');

      throw error;
    }
  }

  /**
   * Configure CNAME record for custom domain
   */
  async configureCNAME(domain: string, tenantId: string) {
    try {
      logger.info({
        domain,
        tenantId,
      }, 'Configuring CNAME record for custom domain');

      if (!this.apiKey) {
        logger.warn('Hostinger API key not configured - returning mock CNAME');
        return { cname: 'cname.vercel-dns.com' };
      }

      // Extract base domain from custom domain
      const domainParts = domain.split('.');
      const baseDomain = domainParts.slice(-2).join('.');
      const subdomain = domainParts.slice(0, -2).join('.');

      // Create CNAME record pointing to Vercel
      const response = await fetch(`${this.apiBaseUrl}/domains/${baseDomain}/dns`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          type: 'CNAME',
          host: subdomain,
          target: 'cname.vercel-dns.com',
          ttl: 3600,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Hostinger API error: ${response.statusText} - ${errorText}`);
      }

      const result = await response.json();

      logger.info({
        domain,
        recordId: result.id,
      }, 'CNAME record configured');

      return {
        cname: 'cname.vercel-dns.com',
        recordId: result.id,
      };
    } catch (error) {
      logger.error({
        error: error instanceof Error ? error.message : 'Unknown error',
        domain,
      }, 'Error configuring CNAME record');

      throw error;
    }
  }

  /**
   * Verify DNS configuration
   */
  async verifyDNS(domain: string) {
    try {
      logger.info({ domain }, 'Verifying DNS configuration');

      if (!this.apiKey) {
        logger.warn('Hostinger API key not configured - returning mock verification');
        return { verified: true, hasCNAME: true };
      }

      // Check DNS records via Hostinger API
      const domainParts = domain.split('.');
      const baseDomain = domainParts.slice(-2).join('.');

      const response = await fetch(`${this.apiBaseUrl}/domains/${baseDomain}/dns`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
        },
      });

      if (!response.ok) {
        throw new Error(`Hostinger API error: ${response.statusText}`);
      }

      const records = await response.json();

      // Check if CNAME exists for the domain
      const subdomain = domainParts.slice(0, -2).join('.');
      const cnameRecord = records.find((r: any) =>
        r.type === 'CNAME' &&
        r.host === subdomain &&
        r.target === 'cname.vercel-dns.com'
      );

      const verified = !!cnameRecord;

      logger.info({
        domain,
        verified,
        hasCNAME: !!cnameRecord,
      }, 'DNS verification complete');

      return { verified, hasCNAME: !!cnameRecord };
    } catch (error) {
      logger.error({
        error: error instanceof Error ? error.message : 'Unknown error',
        domain,
      }, 'Error verifying DNS');

      throw error;
    }
  }

  /**
   * Get email account info
   */
  async getEmailAccount(email: string) {
    try {
      const [username, domain] = email.split('@');

      const response = await fetch(`${this.apiBaseUrl}/domains/${domain}/emails/${username}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
        },
      });

      if (!response.ok) {
        throw new Error(`Hostinger API error: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      logger.error({
        error: error instanceof Error ? error.message : 'Unknown error',
        email,
      }, 'Error getting email account');

      throw error;
    }
  }

  /**
   * Delete email account
   */
  async deleteEmailAccount(email: string) {
    try {
      const [username, domain] = email.split('@');

      logger.info({ email }, 'Deleting Hostinger email account');

      const response = await fetch(`${this.apiBaseUrl}/domains/${domain}/emails/${username}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
        },
      });

      if (!response.ok) {
        throw new Error(`Hostinger API error: ${response.statusText}`);
      }

      logger.info({ email }, 'Email account deleted');
    } catch (error) {
      logger.error({
        error: error instanceof Error ? error.message : 'Unknown error',
        email,
      }, 'Error deleting email account');

      throw error;
    }
  }

  /**
   * Generate a strong random password
   */
  private generateStrongPassword(length: number = 16): string {
    const uppercase = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const lowercase = 'abcdefghijklmnopqrstuvwxyz';
    const numbers = '0123456789';
    const symbols = '!@#$%^&*()_+-=[]{}|;:,.<>?';

    const allChars = uppercase + lowercase + numbers + symbols;
    let password = '';

    // Ensure at least one character from each category
    password += uppercase[Math.floor(Math.random() * uppercase.length)];
    password += lowercase[Math.floor(Math.random() * lowercase.length)];
    password += numbers[Math.floor(Math.random() * numbers.length)];
    password += symbols[Math.floor(Math.random() * symbols.length)];

    // Fill the rest with random characters
    for (let i = password.length; i < length; i++) {
      password += allChars[Math.floor(Math.random() * allChars.length)];
    }

    // Shuffle the password
    return password
      .split('')
      .sort(() => Math.random() - 0.5)
      .join('');
  }
}

export default HostingerApiService;
