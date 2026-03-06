import { Octokit } from 'octokit';
import { logger } from '../db.js';
import { db } from '../db.js';
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, relative } from 'path';

/**
 * Template file structure
 */
interface TemplateFile {
  path: string;
  content: string;
  encoding: 'base64' | 'utf-8';
}

/**
 * GitHub Service
 * Handles GitHub repository creation and management
 */
export class GitHubService {
  private octokit: Octokit;
  private org: string;
  private templateRepo: string;
  private templatePath: string;

  constructor() {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      throw new Error('GITHUB_TOKEN environment variable is required');
    }

    this.octokit = new Octokit({ auth: token });
    this.org = process.env.GITHUB_ORG || 'helmies-bites';
    this.templateRepo = process.env.TEMPLATE_REPO || 'helmies-site-template';
    this.templatePath = process.env.TEMPLATE_PATH || join(process.cwd(), '..', 'helmies-site-template');
  }

  /**
   * Create a new repository for a tenant
   */
  async createTenantRepo(tenantSlug: string, tenantId: string) {
    try {
      const repoName = `${tenantSlug}-site`;
      const description = `Restaurant website for ${tenantSlug}`;

      logger.info({ tenantSlug, tenantId }, 'Creating GitHub repository');

      // Create repository using template
      const { data: repo } = await this.octokit.rest.repos.createInOrg({
        org: this.org,
        name: repoName,
        description,
        auto_init: false,
        private: false,
        has_wiki: false,
        has_projects: false,
        has_downloads: false,
      });

      logger.info({
        tenantSlug,
        repoName: repo.name,
        repoUrl: repo.html_url,
      }, 'GitHub repository created');

      // Update onboarding task
      await db.onboardingTasks.updateByTenantAndType(tenantId, 'github_repo', {
        status: 'completed',
        data: {
          repo_url: repo.html_url,
          repo_name: repo.full_name,
          clone_url: repo.clone_url,
        },
      });

      return repo;
    } catch (error) {
      logger.error({
        error: error instanceof Error ? error.message : 'Unknown error',
        tenantSlug,
        tenantId,
      }, 'Error creating GitHub repository');

      await db.onboardingTasks.updateByTenantAndType(tenantId, 'github_repo', {
        status: 'failed',
        error_message: error instanceof Error ? error.message : 'Unknown error',
      });

      throw error;
    }
  }

  /**
   * Push template code to repository
   */
  async pushTemplateCode(repoName: string, tenantId: string, config: any) {
    try {
      logger.info({ repoName, tenantId }, 'Pushing template code to repository');

      // Get the default branch
      const { data: repo } = await this.octokit.rest.repos.get({
        owner: this.org,
        repo: repoName,
      });

      const defaultBranch = repo.default_branch;

      // Step 1: Create initial commit with template files
      await this.copyTemplateFiles(repoName, defaultBranch, config);

      // Step 2: Create tenant-specific configuration
      const configContent = Buffer.from(
        JSON.stringify({
          tenant: {
            id: config.tenant?.id,
            slug: config.tenant?.slug,
            name: config.tenant?.name,
            nameEn: config.tenant?.nameEn,
            description: config.tenant?.description,
            descriptionEn: config.tenant?.descriptionEn,
          },
          theme: config.theme || {},
          domain: config.domain,
          api: {
            url: process.env.PLATFORM_URL || 'https://api.helmiesbites.com',
            tenantId: config.tenant?.id,
          },
        }, null, 2)
      ).toString('base64');

      await this.octokit.rest.repos.createOrUpdateFileContents({
        owner: this.org,
        repo: repoName,
        path: 'src/config/tenant.config.json',
        message: 'Add tenant configuration',
        content: configContent,
        branch: defaultBranch,
      });

      // Step 3: Create .env file with tenant-specific values
      const envContent = Buffer.create({
        'VITE_SUPABASE_URL': process.env.SUPABASE_URL || '',
        'VITE_SUPABASE_ANON_KEY': process.env.SUPABASE_ANON_KEY || '',
        'VITE_TENANT_ID': config.tenant?.id || '',
        'VITE_TENANT_SLUG': config.tenant?.slug || '',
        'VITE_API_URL': process.env.PLATFORM_URL || 'https://api.helmiesbites.com',
      }, '\n').toString('base64');

      await this.octokit.rest.repos.createOrUpdateFileContents({
        owner: this.org,
        repo: repoName,
        path: '.env',
        message: 'Add environment configuration',
        content: envContent,
        branch: defaultBranch,
      });

      logger.info({ repoName }, 'Template code pushed successfully');

      return { success: true };
    } catch (error) {
      logger.error({
        error: error instanceof Error ? error.message : 'Unknown error',
        repoName,
      }, 'Error pushing template code');

      throw error;
    }
  }

  /**
   * Copy template files from local template directory to repository
   */
  private async copyTemplateFiles(repoName: string, branch: string, config: any) {
    const templateDir = this.templatePath;

    if (!existsSync(templateDir)) {
      logger.warn({ templateDir }, 'Template directory not found, creating minimal structure');
      await this.createMinimalTemplate(repoName, branch, config);
      return;
    }

    const files = this.getAllFiles(templateDir);
    const baseCommit = await this.getBaseCommit(repoName, branch);

    logger.info({ repoName, fileCount: files.length }, 'Copying template files');

    // Create a tree with all files
    const tree = await this.createTree(repoName, files, templateDir, baseCommit);

    // Create a commit with the tree
    const commit = await this.createCommit(repoName, branch, baseCommit, tree);

    logger.info({ repoName, commitSha: commit }, 'Template files committed');
  }

  /**
   * Get all files from directory recursively
   */
  private getAllFiles(dirPath: string, basePath: string = dirPath): string[] {
    const files: string[] = [];
    const entries = readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);

      if (entry.isDirectory()) {
        // Skip node_modules and other common exclusions
        if (['node_modules', '.git', 'dist', 'build', '.next'].includes(entry.name)) {
          continue;
        }
        files.push(...this.getAllFiles(fullPath, basePath));
      } else {
        files.push(fullPath);
      }
    }

    return files;
  }

  /**
   * Create a Git tree with all files
   */
  private async createTree(repoName: string, files: string[], basePath: string, parentCommit: string) {
    const treeItems = [];

    for (const filePath of files) {
      const relativePath = relative(basePath, filePath);

      // Skip certain files
      if (relativePath.includes('node_modules') ||
          relativePath.includes('.env.local') ||
          relativePath.includes('package-lock.json')) {
        continue;
      }

      try {
        const content = readFileSync(filePath);
        const isBinary = this.isBinaryFile(content);

        if (isBinary) {
          // For binary files (images), we'll skip or add placeholder
          continue;
        }

        const base64Content = content.toString('base64');

        // Create blob for each file
        const { data: blob } = await this.octokit.rest.git.createBlob({
          owner: this.org,
          repo: repoName,
          content: base64Content,
          encoding: 'base64',
        });

        treeItems.push({
          path: relativePath.replace(/\\/g, '/'), // Convert Windows paths
          mode: '100644',
          type: 'blob',
          sha: blob.sha,
        });
      } catch (error) {
        logger.warn({ filePath, error }, 'Failed to read file, skipping');
      }
    }

    // Create tree
    const { data: tree } = await this.octokit.rest.git.createTree({
      owner: this.org,
      repo: repoName,
      tree: treeItems as any[],
      base_tree: parentCommit,
    });

    return tree.sha;
  }

  /**
   * Get the base commit for the repository
   */
  private async getBaseCommit(repoName: string, branch: string): Promise<string> {
    try {
      const { data: ref } = await this.octokit.rest.git.getRef({
        owner: this.org,
        repo: repoName,
        ref: `heads/${branch}`,
      });

      return ref.object.sha;
    } catch (error) {
      // Branch doesn't exist, create it
      logger.info({ repoName, branch }, 'Branch does not exist, creating initial commit');

      // Create orphan branch
      const { data: repo } = await this.octokit.rest.repos.get({
        owner: this.org,
        repo: repoName,
      });

      return repo.default_branch || 'main';
    }
  }

  /**
   * Create a commit with the given tree
   */
  private async createCommit(repoName: string, branch: string, parentCommit: string, treeSha: string): Promise<string> {
    const { data: commit } = await this.octokit.rest.git.createCommit({
      owner: this.org,
      repo: repoName,
      message: 'Initial commit from template',
      tree: treeSha,
      parents: [parentCommit],
    });

    // Update the reference
    try {
      await this.octokit.rest.git.updateRef({
        owner: this.org,
        repo: repoName,
        ref: `heads/${branch}`,
        sha: commit.sha,
      });
    } catch (error) {
      logger.warn({ repoName, branch, error }, 'Failed to update ref, branch may not exist yet');
    }

    return commit.sha;
  }

  /**
   * Create minimal template structure
   */
  private async createMinimalTemplate(repoName: string, branch: string, config: any) {
    logger.info({ repoName }, 'Creating minimal template structure');

    const files = [
      {
        path: 'package.json',
        content: JSON.stringify({
          name: `${config.tenant?.slug || 'restaurant'}-site`,
          version: '1.0.0',
          type: 'module',
          scripts: {
            dev: 'vite',
            build: 'vite build',
            preview: 'vite preview',
          },
          dependencies: {
            'react': '^18.3.1',
            'react-dom': '^18.3.1',
            'react-router-dom': '^6.20.0',
            '@tanstack/react-query': '^5.60.5',
          },
          devDependencies: {
            'vite': '^5.4.8',
            '@types/react': '^18.3.1',
            '@types/react-dom': '^18.3.1',
            'typescript': '5.6.3',
            'tailwindcss': '^3.4.17',
            'autoprefixer': '^10.4.20',
            'postcss': '^8.4.47',
          },
        }, null, 2),
      },
      {
        path: 'vite.config.ts',
        content: `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});`,
      },
      {
        path: 'index.html',
        content: `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${config.tenant?.name || 'Restaurant'}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>`,
      },
      {
        path: 'src/main.tsx',
        content: `import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);`,
      },
      {
        path: 'src/App.tsx',
        content: `import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TenantProvider } from './contexts/tenant-context';
import { ThemeProvider } from './contexts/theme-context';
import { LanguageProvider } from './contexts/language-context';
import { CartProvider } from './contexts/cart-context';
import Home from './pages/Home';
import Menu from './pages/Menu';
import Checkout from './pages/Checkout';

const queryClient = new QueryClient();

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TenantProvider>
        <ThemeProvider>
          <LanguageProvider>
            <CartProvider>
              <BrowserRouter>
                <Home />
              </BrowserRouter>
            </CartProvider>
          </LanguageProvider>
        </ThemeProvider>
      </TenantProvider>
    </QueryClientProvider>
  );
}

export default App;`,
      },
    ];

    for (const file of files) {
      const content = Buffer.from(file.content).toString('base64');
      await this.octokit.rest.repos.createOrUpdateFileContents({
        owner: this.org,
        repo: repoName,
        path: file.path,
        message: `Add ${file.path}`,
        content,
        branch,
      });
    }
  }

  /**
   * Check if file is binary
   */
  private isBinaryFile(buffer: Buffer): boolean {
    // Check for common binary file signatures
    const binarySignatures = [
      [0x89, 0x50, 0x4E, 0x47], // PNG
      [0xFF, 0xD8, 0xFF], // JPEG
      [0x47, 0x49, 0x46], // GIF
      [0x25, 0x50, 0x44, 0x46], // PDF
    ];

    for (const sig of binarySignatures) {
      if (buffer.length > sig.length &&
          buffer.subarray(0, sig.length).equals(Buffer.from(sig))) {
        return true;
      }
    }

    // Check for null bytes
    if (buffer.includes(0x00)) {
      return true;
    }

    return false;
  }

  /**
   * Configure GitHub Pages
   */
  async configureGitHubPages(repoName: string, domain: string) {
    try {
      logger.info({ repoName, domain }, 'Configuring GitHub Pages');

      // Enable GitHub Pages
      await this.octokit.rest.repos.createPagesSite({
        owner: this.org,
        repo: repoName,
        source: {
          branch: 'main',
          path: '/',
        },
      });

      // Add custom domain
      await this.octokit.rest.repos.addOrUpdatePagesCustomDomain({
        owner: this.org,
        repo: repoName,
        domain,
      });

      logger.info({ repoName, domain }, 'GitHub Pages configured');

      return { success: true };
    } catch (error) {
      logger.error({
        error: error instanceof Error ? error.message : 'Unknown error',
        repoName,
        domain,
      }, 'Error configuring GitHub Pages');

      throw error;
    }
  }

  /**
   * Create webhook for CI/CD
   */
  async createWebhook(repoName: string, webhookUrl: string) {
    try {
      logger.info({ repoName, webhookUrl }, 'Creating webhook');

      const { data: webhook } = await this.octokit.rest.repos.createWebhook({
        owner: this.org,
        repo: repoName,
        name: 'web',
        active: true,
        config: {
          url: webhookUrl,
          content_type: 'json',
          secret: process.env.GITHUB_WEBHOOK_SECRET || '',
        },
        events: ['push'],
      });

      logger.info({
        repoName,
        webhookId: webhook.id,
      }, 'Webhook created');

      return webhook;
    } catch (error) {
      logger.error({
        error: error instanceof Error ? error.message : 'Unknown error',
        repoName,
      }, 'Error creating webhook');

      throw error;
    }
  }

  /**
   * Get repository information
   */
  async getRepo(repoName: string) {
    try {
      const { data: repo } = await this.octokit.rest.repos.get({
        owner: this.org,
        repo: repoName,
      });

      return repo;
    } catch (error) {
      logger.error({
        error: error instanceof Error ? error.message : 'Unknown error',
        repoName,
      }, 'Error getting repository');

      throw error;
    }
  }

  /**
   * Delete repository
   */
  async deleteRepo(repoName: string) {
    try {
      logger.info({ repoName }, 'Deleting GitHub repository');

      await this.octokit.rest.repos.delete({
        owner: this.org,
        repo: repoName,
      });

      logger.info({ repoName }, 'Repository deleted');
    } catch (error) {
      logger.error({
        error: error instanceof Error ? error.message : 'Unknown error',
        repoName,
      }, 'Error deleting repository');

      throw error;
    }
  }
}

export default GitHubService;
