import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import session from 'express-session';
import PgStore from 'connect-pg-simple';
import { upload } from './middleware/upload.js';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { logger } from './db.js';
import { tenantIsolation } from './middleware/tenant-isolation.js';
import { authMiddleware } from './middleware/auth.js';

// Route imports
import tenantsRouter from './routes/tenants.js';
import wizardRouter from './routes/wizard.js';
import automationRouter from './routes/automation.js';
import stripeRouter from './routes/stripe.js';
import aiRouter from './routes/ai.js';
import supportRouter from './routes/support.js';
import analyticsRouter from './routes/analytics.js';
import customersRouter from './routes/customers.js';
import ordersRouter from './routes/orders.js';
import categoriesRouter from './routes/categories.js';
import menuItemsRouter from './routes/menu-items.js';
import loyaltyRouter from './routes/loyalty.js';
import lounasMenusRouter from './routes/lounas-menus.js';
import lounasSettingsRouter from './routes/lounas-settings.js';
import couponsRouter from './routes/coupons.js';
import deliveryAreasRouter from './routes/delivery-areas.js';
import restaurantConfigRouter from './routes/restaurant-config.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Upload middleware imported from ./middleware/upload.js

// Trust proxy for proper IP detection behind reverse proxy
app.set('trust proxy', 1);

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'"],
      frameSrc: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// CORS configuration
const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:5175',
  'http://localhost:5176',
  'http://localhost:3000',
  'http://localhost:3001',
  'http://69.62.126.13:5173',
  'http://69.62.126.13:5174',
  'http://69.62.126.13:5175',
  'http://69.62.126.13:5176',
  'http://69.62.126.13:3000',
  'http://69.62.126.13:3001',
  'https://bites.helmies.fi',
  'https://admin.helmiesbites.com',
];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);

    // In development, allow localhost and server IP
    if (process.env.NODE_ENV !== 'production') {
      if (origin.includes('localhost') || origin.includes('127.0.0.1') || origin.includes('69.62.126.13')) {
        return callback(null, true);
      }
    }

    // Check if origin is allowed or is a subdomain of helmiesbites.com
    const isAllowed = allowedOrigins.some(allowed => {
      if (allowed.includes('*')) {
        // Handle wildcard subdomains
        const regex = new RegExp(allowed.replace('*', '.*'));
        return regex.test(origin);
      }
      return origin === allowed;
    });

    if (isAllowed) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Tenant-ID', 'X-Request-ID'],
}));

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Session configuration (if needed for admin panel)
if (process.env.SESSION_SECRET) {
  const PostgreSQLStore = PgStore(session);
  app.use(session({
    name: process.env.SESSION_NAME || 'helmies.sid',
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: new PostgreSQLStore({
      conString: process.env.DATABASE_URL,
      tableName: 'session',
      pruneSessionInterval: 60 * 60, // 1 hour
    }),
    cookie: {
      maxAge: parseInt(process.env.SESSION_MAX_AGE || '604800000'), // 7 days
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      domain: process.env.NODE_ENV === 'production' ? '.helmiesbites.com' : undefined,
    },
  }));
}

// Request logging middleware
app.use((req, res, next) => {
  const requestId = req.headers['x-request-id'] || `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  req.id = requestId;

  logger.info({
    requestId,
    method: req.method,
    url: req.url,
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  }, 'Incoming request');

  res.on('finish', () => {
    logger.info({
      requestId,
      method: req.method,
      url: req.url,
      statusCode: res.statusCode,
      responseTime: Date.now() - req.startTime,
    }, 'Request completed');
  });

  req.startTime = Date.now();
  next();
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development',
    version: process.env.npm_package_version || '1.0.0',
  });
});

// API Routes
app.use('/api/tenants', authMiddleware, tenantsRouter);
app.use('/api/wizard', wizardRouter);
app.use('/api/automation', authMiddleware, automationRouter);
app.use('/api/stripe', stripeRouter);
app.use('/api/ai', aiRouter);
app.use('/api/support', authMiddleware, supportRouter);
app.use('/api/analytics', authMiddleware, analyticsRouter);
app.use('/api/customers', authMiddleware, customersRouter);
app.use('/api/orders', ordersRouter);
app.use('/api/categories', categoriesRouter);
app.use('/api/menu-items', menuItemsRouter);
app.use('/api/loyalty', loyaltyRouter);
app.use('/api/lounas-menus', authMiddleware, lounasMenusRouter);
app.use('/api/lounas-settings', authMiddleware, lounasSettingsRouter);
app.use('/api/coupons', authMiddleware, couponsRouter);
app.use('/api/delivery-areas', authMiddleware, deliveryAreasRouter);
app.use('/api/restaurant-config', restaurantConfigRouter);


// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Route ${req.method} ${req.url} not found`,
    requestId: req.id,
  });
});

// Error handling middleware
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  logger.error({
    error: err.message,
    stack: err.stack,
    requestId: req.id,
  }, 'Unhandled error');

  const status = err.status || 500;
  const message = process.env.NODE_ENV === 'production'
    ? 'Internal Server Error'
    : err.message;

  res.status(status).json({
    error: err.name || 'Error',
    message,
    requestId: req.id,
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack }),
  });
});

// Create HTTP server
const server = createServer(app);

// Create WebSocket server for real-time updates
const wss = new WebSocketServer({
  server,
  path: '/ws',
});

// WebSocket connection handler
wss.on('connection', (ws, req) => {
  const tenantId = req.headers['x-tenant-id'] as string;
  const requestId = req.headers['x-request-id'] as string;

  logger.info({
    requestId,
    tenantId,
  }, 'WebSocket connection established');

  // Send welcome message
  ws.send(JSON.stringify({
    type: 'connected',
    timestamp: new Date().toISOString(),
  }));

  // Handle incoming messages
  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());

      logger.debug({
        requestId,
        tenantId,
        messageType: message.type,
      }, 'WebSocket message received');

      // Handle different message types
      switch (message.type) {
        case 'ping':
          ws.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }));
          break;
        case 'subscribe':
          // Subscribe to tenant-specific updates
          if (tenantId) {
            ws.tenantId = tenantId;
            ws.send(JSON.stringify({
              type: 'subscribed',
              tenantId,
              timestamp: new Date().toISOString(),
            }));
          }
          break;
        default:
          ws.send(JSON.stringify({
            type: 'error',
            message: `Unknown message type: ${message.type}`,
          }));
      }
    } catch (error) {
      logger.error({
        error: error instanceof Error ? error.message : 'Unknown error',
        requestId,
        tenantId,
      }, 'WebSocket message handling error');
    }
  });

  // Handle connection close
  ws.on('close', () => {
    logger.info({
      requestId,
      tenantId,
    }, 'WebSocket connection closed');
  });

  // Handle errors
  ws.on('error', (error) => {
    logger.error({
      error: error.message,
      requestId,
      tenantId,
    }, 'WebSocket error');
  });
});

// Broadcast function for sending updates to all connected clients
export function broadcastToTenant(tenantId: string, data: any) {
  wss.clients.forEach((client) => {
    if (client.tenantId === tenantId && client.readyState === 1) {
      client.send(JSON.stringify({
        ...data,
        timestamp: new Date().toISOString(),
      }));
    }
  });
}

// Broadcast to all clients
export function broadcast(data: any) {
  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      client.send(JSON.stringify({
        ...data,
        timestamp: new Date().toISOString(),
      }));
    }
  });
}

/**
 * Send order notification to restaurant staff
 */
export function notifyNewOrder(order: {
  id: string;
  orderNumber: string;
  tenantId: string;
  tenantName: string;
  items: Array<{ name: string; quantity: number }>;
  totalAmount: number;
  deliveryType: string;
  customerName?: string;
  customerPhone?: string;
  customerAddress?: string;
}) {
  broadcastToTenant(order.tenantId, {
    type: 'new_order',
    data: {
      orderId: order.id,
      orderNumber: order.orderNumber,
      items: order.items,
      totalAmount: order.totalAmount,
      deliveryType: order.deliveryType,
      customerName: order.customerName,
      customerPhone: order.customerPhone,
      customerAddress: order.customerAddress,
    },
  });

  logger.info({
    orderId: order.id,
    orderNumber: order.orderNumber,
    tenantId: order.tenantId,
  }, 'Order notification sent via WebSocket');
}

/**
 * Send order status update notification
 */
export function notifyOrderStatusUpdate(order: {
  id: string;
  orderNumber: string;
  tenantId: string;
  status: string;
  customerEmail?: string;
}) {
  // Notify restaurant staff
  broadcastToTenant(order.tenantId, {
    type: 'order_status_update',
    data: {
      orderId: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
    },
  });

  logger.info({
    orderId: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
  }, 'Order status update notification sent');
}

// Start server
server.listen(PORT, () => {
  logger.info({
    port: PORT,
    environment: process.env.NODE_ENV || 'development',
  }, `Helmies Bites Platform API server started`);
});

// Graceful shutdown
const gracefulShutdown = (signal: string) => {
  logger.info({ signal }, 'Received shutdown signal');

  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });

  // Force close after 10 seconds
  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  logger.error({
    error: error.message,
    stack: error.stack,
  }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error({
    reason,
    promise,
  }, 'Unhandled rejection');
});

export default app;
