import { logger } from '../db.js';
import { db } from '../db.js';

/**
 * Vercel Service
 * Handles Vercel project deployment and configuration
 */
export class VercelService {
  private apiKey: string;
  private teamId: string;
  private apiBaseUrl: string;

  constructor() {
    this.apiKey = process.env.VERCEL_API_KEY || '';
    this.teamId = process.env.VERCEL_TEAM_ID || '';
    this.apiBaseUrl = 'https://api.vercel.com/v9';
  }

  /**
   * Create a new Vercel project for a tenant
   */
  async createProject(tenantSlug: string, repoUrl: string, tenantId: string) {
    try {
      const projectName = `${tenantSlug}-site`;

      logger.info({ tenantSlug, tenantId, projectName }, 'Creating Vercel project');

      const response = await fetch(`${this.apiBaseUrl}/projects${this.teamId ? `?teamId=${this.teamId}` : ''}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: projectName,
          framework: 'vite',
          gitRepository: {
            type: 'github',
            repo: repoUrl.replace('https://github.com/', ''),
          },
          buildCommand: 'npm run build',
          outputDirectory: 'dist',
          installCommand: 'npm install',
          env: [
            {
              key: 'VITE_TENANT_SLUG',
              value: tenantSlug,
              type: 'plain',
            },
          ],
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Vercel API error: ${response.statusText} - ${errorText}`);
      }

      const project = await response.json();

      logger.info({
        tenantSlug,
        projectName,
        projectId: project.id,
      }, 'Vercel project created');

      // Update onboarding task
      await db.onboardingTasks.updateByTenantAndType(tenantId, 'vercel_deploy', {
        status: 'completed',
        data: {
          project_id: project.id,
          project_name: project.name,
          project_url: project.url,
        },
      });

      return project;
    } catch (error) {
      logger.error({
        error: error instanceof Error ? error.message : 'Unknown error',
        tenantSlug,
        tenantId,
      }, 'Error creating Vercel project');

      await db.onboardingTasks.updateByTenantAndType(tenantId, 'vercel_deploy', {
        status: 'failed',
        error_message: error instanceof Error ? error.message : 'Unknown error',
      });

      throw error;
    }
  }

  /**
   * Deploy project
   */
  async deployProject(projectId: string, tenantId: string) {
    try {
      logger.info({ projectId, tenantId }, 'Triggering Vercel deployment');

      const response = await fetch(`${this.apiBaseUrl}/projects/${projectId}/deployments${this.teamId ? `?teamId=${this.teamId}` : ''}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: `Production - ${new Date().toISOString()}`,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Vercel API error: ${response.statusText} - ${errorText}`);
      }

      const deployment = await response.json();

      logger.info({
        projectId,
        deploymentId: deployment.id,
        deploymentUrl: deployment.url,
      }, 'Vercel deployment triggered');

      return deployment;
    } catch (error) {
      logger.error({
        error: error instanceof Error ? error.message : 'Unknown error',
        projectId,
      }, 'Error triggering deployment');

      throw error;
    }
  }

  /**
   * Configure custom domain
   */
  async configureDomain(projectId: string, domain: string, tenantId: string) {
    try {
      logger.info({ projectId, domain, tenantId }, 'Configuring Vercel domain');

      const response = await fetch(`${this.apiBaseUrl}/projects/${projectId}/domains${this.teamId ? `?teamId=${this.teamId}` : ''}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: domain,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Vercel API error: ${response.statusText} - ${errorText}`);
      }

      const domainConfig = await response.json();

      logger.info({
        projectId,
        domain,
        domainId: domainConfig.uid,
      }, 'Vercel domain configured');

      // Update tenant domain status
      const tenantDomains = await db.tenantDomains.findByTenantId(tenantId);
      const domainRecord = tenantDomains.find((d: any) => d.domain === domain);

      if (domainRecord) {
        await sql`
          UPDATE public.tenant_domains
          SET ssl_status = 'pending', dns_verified = false
          WHERE id = ${domainRecord.id}
        `;
      }

      return domainConfig;
    } catch (error) {
      logger.error({
        error: error instanceof Error ? error.message : 'Unknown error',
        projectId,
        domain,
      }, 'Error configuring domain');

      throw error;
    }
  }

  /**
   * Verify domain configuration
   */
  async verifyDomain(projectId: string, domain: string) {
    try {
      logger.info({ projectId, domain }, 'Verifying Vercel domain');

      const response = await fetch(`${this.apiBaseUrl}/projects/${projectId}/domains/${domain.replace(/\./g, '-')}${this.teamId ? `?teamId=${this.teamId}` : ''}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Vercel API error: ${response.statusText} - ${errorText}`);
      }

      const domainConfig = await response.json();

      logger.info({
        projectId,
        domain,
        verified: domainConfig.verified,
        hasCname: domainConfig.hasCname,
      }, 'Vercel domain verification complete');

      return {
        verified: domainConfig.verified,
        hasCname: domainConfig.hasCname,
        txtRecord: domainConfig.txtRecord,
        verificationCode: domainConfig.verificationCode,
      };
    } catch (error) {
      logger.error({
        error: error instanceof Error ? error.message : 'Unknown error',
        projectId,
        domain,
      }, 'Error verifying domain');

      throw error;
    }
  }

  /**
   * Get project information
   */
  async getProject(projectId: string) {
    try {
      const response = await fetch(`${this.apiBaseUrl}/projects/${projectId}${this.teamId ? `?teamId=${this.teamId}` : ''}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
        },
      });

      if (!response.ok) {
        throw new Error(`Vercel API error: ${response.statusText}`);
      }

      return await response.json();
    } catch (error) {
      logger.error({
        error: error instanceof Error ? error.message : 'Unknown error',
        projectId,
      }, 'Error getting project');

      throw error;
    }
  }

  /**
   * Delete project
   */
  async deleteProject(projectId: string) {
    try {
      logger.info({ projectId }, 'Deleting Vercel project');

      const response = await fetch(`${this.apiBaseUrl}/projects/${projectId}${this.teamId ? `?teamId=${this.teamId}` : ''}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
        },
      });

      if (!response.ok) {
        throw new Error(`Vercel API error: ${response.statusText}`);
      }

      logger.info({ projectId }, 'Vercel project deleted');
    } catch (error) {
      logger.error({
        error: error instanceof Error ? error.message : 'Unknown error',
        projectId,
      }, 'Error deleting project');

      throw error;
    }
  }
}

export default VercelService;
